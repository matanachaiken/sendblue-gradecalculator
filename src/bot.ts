// bot.ts — Conversation logic: routes messages, manages state, sends replies
//
// Key design principle: the syllabus is always the source of truth for grading
// weights. Canvas is used solely to pull assignment scores into those categories.
//
// State machine overview:
//
// Choice questions (yes/no, numbered menus) are stored as pendingConfirmation
// in userState and checked FIRST on every incoming message. Data-input steps
// use the step field as before.
//
//  New class (data-input steps):
//    idle → awaiting_syllabus → [awaiting_curve_flat | awaiting_curve_mean]
//         → awaiting_canvas_url → awaiting_canvas_token
//         → awaiting_assignment_classification
//         → idle
//
//  Choice questions (pendingConfirmation types):
//    curve_type | canvas_choice | canvas_course | new_class_mode
//    confirm_delete | confirm_reset | confirm_intent
//
//  Update syllabus mid-semester:
//    intent: update_syllabus → awaiting_syllabus (existing grades preserved)
//
//  On-demand sync:
//    intent: sync_canvas → rebuild grades from Canvas, classify new assignments

import axios from 'axios';
import sharp from 'sharp';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse') as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
import { sendMessage } from './sendblue.js';
import { parseSyllabus, parseSyllabusFromUrl, parseSyllabusFromImage, classifyIntent, batchMatchAssignments } from './claude.js';
import { getCourses, getScoredAssignments } from './canvas.js';
import {
  getUserState,
  setUserState,
  setPendingConfirmation,
  clearPendingConfirmation,
  getAllClasses,
  getClass,
  saveClass,
  deleteClass,
  getConfig,
  saveConfig,
  setEnvVar,
  resetClasses,
  resetAll,
  saveLastAction,
  getLastAction,
  clearLastAction,
} from './storage.js';
import {
  calcCurrentGrade,
  calcNeeded,
  calcBestPossible,
  calcGPA,
  getLetterGrade,
} from './grades.js';
import type { ClassData, Intent, PendingConfirmation, UserState, LastAction, LastActionInput, CanvasCourse, CanvasAssignment } from './types.js';

// Max ambiguous assignments we ask about before silently skipping the rest
const MAX_CLARIFY = 5;

// ─── Entry Point ─────────────────────────────────────────────────────────────

export async function handleIncomingMessage(from: string, text: string, mediaUrl: string | null): Promise<void> {
  // Read state fresh from disk — this is the FIRST thing, always.
  const state = getUserState(from);
  const trimmed = text.trim();

  console.log('PENDING STATE:', JSON.stringify(state.pendingConfirmation || null));
  if (mediaUrl) console.log('[media] url received, step:', state.step);

  // pendingConfirmation wins over EVERYTHING — check before media, before step, before intent.
  if (state.pendingConfirmation) {
    if (!trimmed) return; // no text to act on
    await handlePendingConfirmation(from, state.pendingConfirmation, trimmed, state);
    return;
  }

  // If awaiting a syllabus and a file arrived, always try to read it —
  // even if there is also text content (e.g. filename sent alongside the attachment).
  if (mediaUrl && state.step === 'awaiting_syllabus') {
    await handleSyllabusPhoto(from, mediaUrl, state);
    return;
  }

  // File received outside of syllabus setup
  if (mediaUrl && !trimmed) {
    await sendMessage(from, 'To read a syllabus photo or PDF, say "new class: [name]" first, then send the file.');
    return;
  }

  if (!trimmed) return;

  if (state.step !== 'idle') {
    await handleSetupFlow(from, trimmed, state);
    return;
  }

  const classes = getAllClasses(from);
  const intent = await classifyIntent(trimmed, classes);
  await handleIntent(from, trimmed, intent);
}

// ─── Pending Confirmation Handler ────────────────────────────────────────────
//
// All yes/no and numbered-choice questions are stored as pendingConfirmation
// in the user state (persisted to classes.json). Every incoming message checks
// this first so context is never lost between messages.

async function handlePendingConfirmation(from: string, pc: PendingConfirmation, answer: string, state: UserState): Promise<void> {
  console.log('HANDLING PENDING:', pc.type, 'ANSWER:', answer);
  const lower = answer.toLowerCase().trim();
  const isYes = /^(y(es|eah|ep)?|1)$/.test(lower);
  const isNo  = /^(no?|nope|nah|2|cancel)$/.test(lower);

  // Clear pendingConfirmation before executing anything
  clearPendingConfirmation(from);

  switch (pc.type) {

    case 'curve_type': {
      const className = pc.data.className as string;
      let curveType: string | null = null;
      if (/^(1|flat)/.test(lower))         curveType = 'flat';
      else if (/^(2|mean|scale)/.test(lower)) curveType = 'mean';
      else if (/^(3|norm)/.test(lower))    curveType = 'norm';
      else if (/^(4|none|no)/.test(lower)) curveType = 'none';

      if (!curveType) {
        setPendingConfirmation(from, pc);
        await sendMessage(from, 'Reply 1 (flat points), 2 (scale to mean), 3 (norm-referenced), or 4 (no curve).');
        return;
      }

      if (curveType === 'flat') {
        setUserState(from, { step: 'awaiting_curve_flat', pendingClass: className });
        await sendMessage(from, 'How many points does the professor add to each score?');
        return;
      }
      if (curveType === 'mean') {
        setUserState(from, { step: 'awaiting_curve_mean', pendingClass: className });
        await sendMessage(from, 'What does the professor want the class average to be? (Or "unknown" — you can set it later.)');
        return;
      }
      // norm or none — no extra setup needed now; norm data is entered per-assignment
      const cdCurve = getClass(from, className.toLowerCase());
      if (cdCurve) {
        cdCurve.curve = { type: curveType as 'norm' | 'none' };
        saveClass(from, className.toLowerCase(), cdCurve);
      }
      const curveNote = curveType === 'norm'
        ? "Norm-referenced curve saved. When you enter class medians later, I'll ask what letter grade the prof maps the median to."
        : 'No curve.';
      await offerCanvas(from, className, curveNote);
      break;
    }

    case 'canvas_choice': {
      const className = pc.data.className as string;
      if (isYes) {
        const config = getConfig(from);
        if (config.canvasConnected && process.env.CANVAS_TOKEN && process.env.CANVAS_BASE_URL) {
          await pickCanvasCourse(from, className);
        } else {
          setUserState(from, { step: 'awaiting_canvas_url', pendingClass: className });
          await sendMessage(from, "What's your Canvas URL? (e.g. canvas.youruniversity.edu — just the domain, no https://)");
        }
      } else {
        setUserState(from, { step: 'idle', pendingClass: null });
        const classKey = className.toLowerCase();
        const hasGrades = Object.values(getClass(from, classKey)?.grades || {}).some(arr => arr.length > 0);
        if (hasGrades) {
          await showGrade(from, classKey);
        } else {
          await sendMessage(from, `${className} is all set! Log grades with "got 85 on midterm" or text "connect canvas" any time.`);
        }
      }
      break;
    }

    case 'canvas_course': {
      const className = pc.data.className as string;
      const courses = pc.data.courses as CanvasCourse[];
      if (lower === 'skip') {
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, `OK, skipping Canvas sync for ${className}. You can always do this later with "connect canvas".`);
        return;
      }

      const idx = parseInt(answer.trim()) - 1;
      let selectedCourse: CanvasCourse | undefined;
      if (!isNaN(idx) && idx >= 0 && idx < courses.length) {
        selectedCourse = courses[idx];
      } else {
        selectedCourse = courses.find(c =>
          c.name.toLowerCase().includes(lower) || lower.includes(c.name.toLowerCase().split(':')[0].trim())
        );
      }

      if (!selectedCourse) {
        setPendingConfirmation(from, pc);
        await sendMessage(from, `Didn't find that. Reply with a number (1–${courses.length}) or "skip".`);
        return;
      }

      const classKey = className.toLowerCase();
      const preCanvasData = JSON.parse(JSON.stringify(getClass(from, classKey))) as ClassData;
      const cdCanvas = getClass(from, classKey);
      if (!cdCanvas) break;
      cdCanvas.canvasId = selectedCourse.id;
      cdCanvas.canvasSynced = true;
      cdCanvas.canvasAssignmentMap = cdCanvas.canvasAssignmentMap || {};
      saveClass(from, classKey, cdCanvas);
      setUserState(from, { step: 'idle', pendingClass: null });

      await sendMessage(from, `Linked to "${selectedCourse.name}". Pulling scores...`);
      await performCanvasSync(from, [classKey]);
      saveLastAction(from, { type: 'canvas_linked', classKey, className: cdCanvas.name, previousClassData: preCanvasData });
      break;
    }

    case 'new_class_mode': {
      const className = pc.data.className as string;
      const isRestart = /^(1|restart|clear|fresh|start over)$/.test(lower);
      const isKeep    = /^(2|keep|update)$/.test(lower);

      if (!isRestart && !isKeep) {
        setPendingConfirmation(from, pc);
        await sendMessage(from, 'Reply "restart" to start fresh (clears grades) or "keep" to update weights and keep grades.');
        return;
      }

      setUserState(from, { step: 'awaiting_syllabus', pendingClass: className, pendingRestart: isRestart });
      await sendMessage(from, `Got it! Paste the grading breakdown for ${className}.`);
      break;
    }

    case 'confirm_delete': {
      const classKey = pc.data.classKey as string;
      if (isYes) {
        const cdDel = getClass(from, classKey);
        const displayName = cdDel?.name || classKey;
        deleteClass(from, classKey);
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, `${displayName} deleted.`);
      } else {
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, 'OK, keeping it.');
      }
      break;
    }

    case 'confirm_reset': {
      const t = answer.trim();
      if (t === '1' || isYes) {
        resetClasses(from);
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, 'Done — all classes and grades deleted. Canvas is still connected. Start fresh with "new class: [name]".');
      } else if (t === '2') {
        resetAll(from);
        setEnvVar('CANVAS_TOKEN', '');
        setEnvVar('CANVAS_BASE_URL', '');
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, 'Done — all classes, grades, and Canvas connection deleted. Start fresh with "new class: [name]".');
      } else {
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, 'Cancelled.');
      }
      break;
    }

    case 'confirm_intent': {
      const confirmedIntent = pc.data.intent as Intent;
      if (isYes) {
        setUserState(from, { step: 'idle', pendingClass: null });
        await handleIntent(from, '', confirmedIntent);
      } else if (isNo) {
        setUserState(from, { step: 'idle', pendingClass: null });
        await sendMessage(from, 'OK, what did you mean? Or text "help" to see all commands.');
      } else {
        // Re-classify as a fresh message
        setUserState(from, { step: 'idle', pendingClass: null });
        const classes = getAllClasses(from);
        const freshIntent = await classifyIntent(answer, classes);
        await handleIntent(from, answer, freshIntent);
      }
      break;
    }

    case 'norm_mapped_grade': {
      const classKey = pc.data.classKey as string;
      const median = pc.data.median as number;
      const VALID = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
      const letter = answer.trim().toUpperCase();

      if (!VALID.includes(letter)) {
        setPendingConfirmation(from, pc);
        await sendMessage(from, `Enter a valid letter grade: ${VALID.join(', ')}`);
        return;
      }

      const cdNorm = getClass(from, classKey);
      if (!cdNorm) break;
      const previousMappedGrade = cdNorm.curve?.mappedGrade ?? null;
      cdNorm.curve = { ...cdNorm.curve, mappedGrade: letter };
      saveClass(from, classKey, cdNorm);
      saveLastAction(from, { type: 'norm_grade_saved', classKey, className: cdNorm.name, previousValue: previousMappedGrade ?? null, newValue: letter });

      await sendMessage(from, `Got it — class median ${median} maps to ${letter} for ${cdNorm.name}.`);
      await showGrade(from, classKey);
      break;
    }

    case 'awaiting_numeric_median': {
      const classKey = pc.data.classKey as string;
      const letter = pc.data.letter as string;
      const cdNorm = getClass(from, classKey);
      if (!cdNorm) break;

      const lower2 = answer.toLowerCase().trim();
      const isSkip = lower2 === 'skip' || isYes;
      const median = parseFloat(answer);

      if (isSkip) {
        cdNorm.curve = { ...cdNorm.curve, mappedGrade: letter };
        saveClass(from, classKey, cdNorm);
        await sendMessage(from, `Got it — target grade is ${letter} for ${cdNorm.name}. If you get the numeric median later just text it like: "class median was 72 for ${cdNorm.name.toLowerCase()}"`);
        await showGrade(from, classKey);
      } else if (!isNaN(median)) {
        cdNorm.curve = { ...cdNorm.curve, median, mappedGrade: letter };
        saveClass(from, classKey, cdNorm);
        await sendMessage(from, `Got it — class median ${median} maps to ${letter} for ${cdNorm.name}.`);
        await showGrade(from, classKey);
      } else {
        setPendingConfirmation(from, pc);
        await sendMessage(from, `Enter the numeric median score (e.g. 72), or reply "skip" if there's no number.`);
      }
      break;
    }

    // Legacy cases kept for any states persisted before the flow change
    case 'norm_median_confirm': {
      const classKey = pc.data.classKey as string;
      const letter = pc.data.letter as string;
      const cdNorm = getClass(from, classKey);
      if (!cdNorm) break;
      if (isYes) {
        cdNorm.curve = { ...cdNorm.curve, mappedGrade: letter };
        saveClass(from, classKey, cdNorm);
        await sendMessage(from, `Got it — target grade is ${letter} for ${cdNorm.name}.`);
        await showGrade(from, classKey);
      } else {
        setPendingConfirmation(from, { type: 'awaiting_numeric_median', data: { classKey, letter }, question: `What was the numeric median? (e.g. 72)` });
        await sendMessage(from, 'Enter the numeric median score (e.g. 72), or reply "skip" if there\'s no number.');
      }
      break;
    }

    case 'norm_median_then_letter': {
      const classKey = pc.data.classKey as string;
      const letter = pc.data.letter as string;
      const median = parseFloat(answer);
      if (isNaN(median)) {
        setPendingConfirmation(from, pc);
        await sendMessage(from, 'Enter a number for the median (e.g. 72).');
        return;
      }
      const cdNorm = getClass(from, classKey);
      if (!cdNorm) break;
      cdNorm.curve = { ...cdNorm.curve, median, mappedGrade: letter };
      saveClass(from, classKey, cdNorm);
      await sendMessage(from, `Got it — class median ${median} maps to ${letter} for ${cdNorm.name}.`);
      await showGrade(from, classKey);
      break;
    }

    case 'confirm_undo': {
      if (!isYes) {
        await sendMessage(from, 'Cancelled.');
        break;
      }

      const last = pc.data.last as LastAction;
      clearLastAction(from);

      switch (last.type) {
        case 'grade_saved': {
          const cd = getClass(from, last.classKey);
          if (cd) { cd.grades[last.catKey] = last.previousGrades; saveClass(from, last.classKey, cd); }
          await sendMessage(from, `Undone — removed ${last.catDisplay} grade of ${last.score} from ${last.className}.`);
          break;
        }
        case 'grade_deleted': {
          const cd = getClass(from, last.classKey);
          if (cd) { cd.grades[last.catKey] = last.previousGrades; saveClass(from, last.classKey, cd); }
          await sendMessage(from, `Undone — restored ${last.catDisplay} grade of ${last.removedScore} in ${last.className}.`);
          break;
        }
        case 'class_average_saved': {
          const cd = getClass(from, last.classKey);
          if (cd) {
            if (last.field === 'curve.classAvg') {
              if (last.previousValue == null) { delete cd.curve.classAvg; } else { cd.curve = { ...cd.curve, classAvg: last.previousValue }; }
            } else if (last.field === 'curve.median') {
              if (last.previousValue == null) { delete cd.curve.median; } else { cd.curve = { ...cd.curve, median: last.previousValue }; }
            } else if (last.field?.startsWith('classAverages.')) {
              const catKey = last.field.slice('classAverages.'.length);
              if (!cd.classAverages) cd.classAverages = {};
              if (last.previousValue == null) { delete cd.classAverages[catKey]; } else { cd.classAverages[catKey] = last.previousValue; }
            }
            saveClass(from, last.classKey, cd);
          }
          await sendMessage(from, `Undone — removed ${last.label || 'class average'} for ${last.className}.`);
          break;
        }
        case 'norm_grade_saved': {
          const cd = getClass(from, last.classKey);
          if (cd) {
            if (last.previousValue == null) { delete cd.curve.mappedGrade; } else { cd.curve = { ...cd.curve, mappedGrade: last.previousValue }; }
            saveClass(from, last.classKey, cd);
          }
          await sendMessage(from, `Undone — removed norm curve letter grade for ${last.className}.`);
          break;
        }
        case 'class_added': {
          deleteClass(from, last.classKey);
          await sendMessage(from, `Undone — deleted ${last.className}.`);
          break;
        }
        case 'syllabus_updated': {
          saveClass(from, last.classKey, last.previousClassData);
          await sendMessage(from, `Undone — restored previous syllabus weights for ${last.className}.`);
          break;
        }
        case 'canvas_linked': {
          saveClass(from, last.classKey, last.previousClassData);
          await sendMessage(from, `Undone — unlinked Canvas from ${last.className} and restored previous grades.`);
          const resyncQ = `Want to re-sync Canvas for ${last.className}? (yes/no)`;
          setPendingConfirmation(from, { type: 'canvas_resync_offer', data: { classKey: last.classKey, className: last.className }, question: resyncQ });
          console.log('SAVED PENDING:', 'canvas_resync_offer', last.classKey);
          await sendMessage(from, resyncQ);
          break;
        }
        default:
          await sendMessage(from, 'Undone.');
      }
      break;
    }

    case 'canvas_resync_offer': {
      const className = pc.data.className as string;
      if (isYes) {
        await offerCanvas(from, className, '');
      } else {
        await sendMessage(from, 'OK. Text "connect canvas" any time to re-link.');
      }
      break;
    }

    case 'norm_median_from_number': {
      const classKey = pc.data.classKey as string;
      const num = pc.data.num as number;
      if (isYes) {
        const cd = getClass(from, classKey);
        if (!cd) break;
        const previousValue = cd.curve?.median ?? null;
        cd.curve = { ...cd.curve, median: num };
        saveClass(from, classKey, cd);
        saveLastAction(from, { type: 'class_average_saved', classKey, className: cd.name, field: 'curve.median', previousValue, newValue: num, label: 'class median' });
        await sendMessage(from, `Saved — class median ${num} for ${cd.name}.`);
        if (!cd.curve.mappedGrade) {
          const q = `What letter grade does the professor map that median to for ${cd.name}? (e.g. B+)`;
          setPendingConfirmation(from, { type: 'norm_mapped_grade', data: { classKey, median: num }, question: q });
          console.log('SAVED PENDING:', 'norm_mapped_grade', classKey);
          await sendMessage(from, q);
        } else {
          await showGrade(from, classKey);
        }
      } else if (isNo) {
        await sendMessage(from, `OK — what did you mean? Try: "class median was 72 for data structures"`);
      } else {
        setPendingConfirmation(from, pc);
        await sendMessage(from, 'Reply "yes" or "no".');
      }
      break;
    }

    case 'norm_median_class_choice': {
      const num = pc.data.num as number;
      const classes = pc.data.classes as Array<{ classKey: string; name: string }>;
      const idx = parseInt(answer.trim()) - 1;
      let selected: { classKey: string; name: string } | undefined;

      if (!isNaN(idx) && idx >= 0 && idx < classes.length) {
        selected = classes[idx];
      } else {
        selected = classes.find(c => c.name.toLowerCase().includes(lower));
      }

      if (!selected) {
        setPendingConfirmation(from, pc);
        const list = classes.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
        await sendMessage(from, `Didn't recognize that. Reply with a number:\n${list}`);
        return;
      }

      const { classKey: chosenKey, name: chosenName } = selected;
      const cd = getClass(from, chosenKey);
      if (!cd) break;
      const previousValue = cd.curve?.median ?? null;
      cd.curve = { ...cd.curve, median: num };
      saveClass(from, chosenKey, cd);
      saveLastAction(from, { type: 'class_average_saved', classKey: chosenKey, className: chosenName, field: 'curve.median', previousValue, newValue: num, label: 'class median' });
      await sendMessage(from, `Saved — class median ${num} for ${chosenName}.`);
      if (!cd.curve.mappedGrade) {
        const q = `What letter grade does the professor map that median to for ${chosenName}? (e.g. B+)`;
        setPendingConfirmation(from, { type: 'norm_mapped_grade', data: { classKey: chosenKey, median: num }, question: q });
        console.log('SAVED PENDING:', 'norm_mapped_grade', chosenKey);
        await sendMessage(from, q);
      } else {
        await showGrade(from, chosenKey);
      }
      break;
    }

    case 'manual_entry_offer': {
      const classKey = pc.data.classKey as string;
      const className = getClass(from, classKey)?.name || classKey;
      setUserState(from, { step: 'idle', pendingClass: null });
      if (isYes) {
        await sendMessage(from, `Sure — text your grade like:\n"got an 88 on the midterm for ${className}"`);
      } else {
        await sendMessage(from, `No problem! I'll update automatically when Canvas shows grades.`);
      }
      break;
    }

    default:
      setUserState(from, { step: 'idle', pendingClass: null });
      await sendMessage(from, 'Lost track of what we were doing. Text "help" to start over.');
  }
}

/**
 * Download a syllabus photo and parse it with Claude vision.
 * Shares the same save + confirm logic as the text syllabus path.
 */
async function handleSyllabusPhoto(from: string, mediaUrl: string, state: UserState): Promise<void> {
  await sendMessage(from, 'Reading your syllabus...');

  let parsed = null;

  // Attempt 1: pass the URL directly to Claude (no download needed)
  try {
    parsed = await parseSyllabusFromUrl(mediaUrl, state.pendingClass);
  } catch (urlErr) {
    const e = urlErr as { response?: { data?: { error?: { message?: string } } }; message?: string };
    console.log('Direct URL failed, trying download:', e.response?.data?.error?.message || e.message);
  }

  // Attempt 2: download with Sendblue credentials, send as base64
  if (!parsed?.categories?.length) {
    try {
      const res = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        headers: {
          'sb-api-key-id': process.env.SENDBLUE_API_KEY,
          'sb-api-secret-key': process.env.SENDBLUE_API_SECRET,
        },
      });

      const rawType = ((res.headers as Record<string, string>)['content-type'] || '').split(';')[0].trim().toLowerCase();
      console.log('[media] content-type:', rawType, '| bytes:', (res.data as ArrayBuffer).byteLength);

      const buf = Buffer.from(res.data as ArrayBuffer);

      if (rawType === 'application/pdf') {
        // Extract text from PDF and use the normal text parser — more reliable than OCR
        console.log('[media] extracting text from PDF');
        const pdfData = await pdfParse(buf);
        const text = pdfData.text;
        if (!text?.trim()) {
          await sendMessage(from, "This PDF appears to be a scanned image — I can't extract text from it directly. Try copy-pasting the grading breakdown section as text instead.");
          return;
        }
        parsed = await parseSyllabus(state.pendingClass, text);
      } else {
        // Image path — convert unsupported formats (HEIC, etc.) to JPEG via sharp
        const SUPPORTED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        const mediaType = rawType === 'image/jpg' ? 'image/jpeg' : rawType;
        let imageBuffer: Buffer = buf;
        if (!SUPPORTED.includes(mediaType)) {
          console.log('[media] converting', mediaType, '→ image/jpeg');
          imageBuffer = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
        }
        const finalType = SUPPORTED.includes(mediaType) ? mediaType : 'image/jpeg';
        const base64 = imageBuffer.toString('base64');
        parsed = await parseSyllabusFromImage(base64, finalType, state.pendingClass);
      }
    } catch (dlErr) {
      const e = dlErr as { response?: { data?: unknown }; message?: string };
      console.error('Download also failed:', e.response?.data || e.message);
      await sendMessage(from, "Couldn't read that photo. Try pasting the grading breakdown as text instead.");
      return;
    }
  }

  if (!parsed?.categories?.length) {
    await sendMessage(from, "Couldn't find grading categories in that photo. Try a closer shot or paste the text.");
    return;
  }

  await processParsedSyllabus(from, state.pendingClass, parsed, state.pendingRestart === true);
}

// ─── Multi-Step Setup Flow ────────────────────────────────────────────────────

async function handleSetupFlow(from: string, text: string, state: UserState): Promise<void> {
  const { step, pendingClass } = state;

  // Allow escape from any setup step via recognized commands
  const lower = text.toLowerCase().trim();
  const ESCAPE_PATTERNS = [
    /^cancel$/,
    /^stop$/,
    /^quit$/,
    /^reset$/,
    /^undo$/,
    /^nevermind$/,
    /^oops$/,
    /^(connect|setup|login)\s*(canvas)?$/,
    /^new\s+class\s*[:\-]/i,
    /^help$/,
    /^show all/,
    /^delete\s+/,
    /^sync\s+canvas/,
  ];
  const isEscape = ESCAPE_PATTERNS.some(p => p.test(lower));

  if (isEscape && step !== 'awaiting_canvas_url' && step !== 'awaiting_canvas_token') {
    setUserState(from, { step: 'idle', pendingClass: null });
    const classes = getAllClasses(from);
    const intent = await classifyIntent(text, classes);
    await handleIntent(from, text, intent);
    return;
  }

  // ── Syllabus (new class OR update) ────────────────────────────────────────
  if (step === 'awaiting_syllabus') {
    await sendMessage(from, 'Parsing your syllabus...');

    const parsed = await parseSyllabus(pendingClass, text);

    if (!parsed?.categories?.length) {
      await sendMessage(
        from,
        "Couldn't find grading categories. Try pasting just the breakdown section (e.g. \"Midterm 30%, Final 40%\")."
      );
      return;
    }

    await processParsedSyllabus(from, pendingClass, parsed, state.pendingRestart === true);
    return;
  }

  // ── Curve: flat points ────────────────────────────────────────────────────
  if (step === 'awaiting_curve_flat') {
    const points = parseFloat(text);
    if (isNaN(points)) {
      await sendMessage(from, 'Enter a number (e.g. 5 for +5 points).');
      return;
    }

    const classKey = (pendingClass || '').toLowerCase();
    const classData = getClass(from, classKey);
    if (!classData) return;
    classData.curve = { type: 'flat', flatPoints: points };
    saveClass(from, classKey, classData);

    await offerCanvas(from, pendingClass || '', `+${points} pts added to all scores.`);
    return;
  }

  // ── Curve: mean target ────────────────────────────────────────────────────
  if (step === 'awaiting_curve_mean') {
    const lowerText = text.toLowerCase().trim();
    let targetMean: number | null = null;

    if (lowerText !== 'unknown') {
      targetMean = parseFloat(text);
      if (isNaN(targetMean)) {
        await sendMessage(from, 'Enter a number for the target average (e.g. 75) or "unknown".');
        return;
      }
    }

    const classKey = (pendingClass || '').toLowerCase();
    const classData = getClass(from, classKey);
    if (!classData) return;
    classData.curve = { type: 'mean', targetMean };
    saveClass(from, classKey, classData);

    const note =
      targetMean !== null
        ? `Class average will be scaled to ${targetMean}.`
        : 'Curve saved — enter the class average when you get it.';
    await offerCanvas(from, pendingClass || '', note);
    return;
  }

  // ── Canvas: collect URL ───────────────────────────────────────────────────
  if (step === 'awaiting_canvas_url') {
    const baseUrl = text.trim().replace(/^https?:\/\//i, '').replace(/\/$/, '');
    // Store URL in pendingClass as JSON so we can carry both className and baseUrl
    setUserState(from, {
      step: 'awaiting_canvas_token',
      pendingClass: JSON.stringify({ className: pendingClass, baseUrl }),
    });
    await sendMessage(
      from,
      `Got it (${baseUrl})!\n\nNow get your Canvas access token:\nCanvas → Account → Settings → Approved Integrations → New Access Token\n\nPaste it here.`
    );
    return;
  }

  // ── Canvas: validate token ────────────────────────────────────────────────
  if (step === 'awaiting_canvas_token') {
    let parsedState: { className?: string; baseUrl?: string } = {};
    try { parsedState = JSON.parse(pendingClass || '{}') as { className?: string; baseUrl?: string }; } catch { parsedState = {}; }
    const { className, baseUrl } = parsedState;
    const token = text.trim();

    await sendMessage(from, 'Connecting to Canvas...');

    try {
      await getCourses(baseUrl || '', token); // throws CANVAS_AUTH_ERROR on bad token
      setEnvVar('CANVAS_TOKEN', token);
      setEnvVar('CANVAS_BASE_URL', baseUrl || '');
      saveConfig(from, { ...getConfig(from), canvasConnected: true });

      // Back to canvas_choice but now connected — pick a course
      await pickCanvasCourse(from, className || '');
    } catch (err) {
      const e = err as { message?: string };
      if (e.message === 'CANVAS_AUTH_ERROR') {
        // Stay in this step so user can re-paste
        await sendMessage(
          from,
          "That token didn't work. Make sure you copied the full token and try again. (Or reply \"skip\" to set up Canvas later.)"
        );
      } else {
        // URL might be wrong — back up to URL step
        setUserState(from, {
          step: 'awaiting_canvas_url',
          pendingClass: className || pendingClass,
        });
        await sendMessage(from, "Couldn't connect — double-check your Canvas URL and send it again.");
      }
    }
    return;
  }

  // ── Assignment classification ─────────────────────────────────────────────
  if (step === 'awaiting_assignment_classification') {
    let parsedState: { classKey?: string; current?: CanvasAssignment; queue?: CanvasAssignment[]; skippedCount?: number } = {};
    try { parsedState = JSON.parse(pendingClass || '{}') as typeof parsedState; } catch { parsedState = {}; }
    const { classKey, current, queue = [], skippedCount = 0 } = parsedState;

    if (!classKey || !current) {
      setUserState(from, { step: 'idle', pendingClass: null });
      return;
    }

    const classData = getClass(from, classKey);
    if (!classData) {
      setUserState(from, { step: 'idle', pendingClass: null });
      return;
    }

    // Split compound messages like "skip. Class average: 80"
    const dotIdx = text.search(/\.\s+\S/);
    const classificationText = dotIdx >= 0 ? text.slice(0, dotIdx).trim() : text.trim();
    const remainderText = dotIdx >= 0 ? text.slice(dotIdx + 1).trim() : '';

    const lowerClass = classificationText.toLowerCase();

    if (lowerClass === 'skip') {
      if (!classData.canvasAssignmentMap) classData.canvasAssignmentMap = {};
      classData.canvasAssignmentMap[current.id] = null;
      saveClass(from, classKey, classData);
    } else {
      const catKey = findCategoryKey(classData, classificationText);
      if (!catKey) {
        const catNames = classData.categories.map(c => c.name).join(', ');
        await sendMessage(from, `Didn't recognize that category. Options: ${catNames}\n\nOr reply "skip".`);
        return;
      }
      if (!classData.canvasAssignmentMap) classData.canvasAssignmentMap = {};
      classData.canvasAssignmentMap[current.id] = catKey;
      classData.canvasGrades = classData.canvasGrades || {};
      classData.canvasGrades[catKey] = classData.canvasGrades[catKey] || [];
      classData.canvasGrades[catKey].push(current.percentage);
      saveClass(from, classKey, classData);
    }

    // Process any additional content in the same message
    if (remainderText) {
      const extraClasses = getAllClasses(from);
      const extraIntent = await classifyIntent(remainderText, extraClasses);
      if (extraIntent.action !== 'unknown') {
        await handleIntent(from, remainderText, extraIntent);
      }
    }

    if (queue.length > 0) {
      const next = queue[0];
      const rest = queue.slice(1);
      setUserState(from, {
        step: 'awaiting_assignment_classification',
        pendingClass: JSON.stringify({ classKey, current: next, queue: rest, skippedCount }),
      });
      await askAboutAssignment(from, classData, next, rest.length + skippedCount);
    } else {
      setUserState(from, { step: 'idle', pendingClass: null });
      const skipNote = skippedCount > 0
        ? `(${skippedCount} more ambiguous assignment${skippedCount > 1 ? 's' : ''} were auto-skipped.)`
        : '';
      if (skipNote) await sendMessage(from, skipNote);
      await showGrade(from, classKey);
    }
    return;
  }

}

// ─── Intent Handlers ─────────────────────────────────────────────────────────

async function handleIntent(from: string, text: string, intent: Intent): Promise<void> {
  const { action } = intent;

  // ── Multiple intents in one message ───────────────────────────────────────
  if (action === 'multi') {
    for (const sub of intent.intents) {
      await handleIntent(from, text, { ...sub, _batchMode: true } as Intent);
    }
    const batchClassKeys = [...new Set(
      intent.intents.filter((i): i is Extract<Intent, { classKey: string }> => 'classKey' in i && !!i.classKey).map(i => i.classKey)
    )];
    for (const batchKey of batchClassKeys) {
      const bcd = getClass(from, batchKey);
      // For norm curves: if median was just set but mapped grade is missing, ask once
      if (bcd?.curve?.type === 'norm' && bcd.curve.median != null && !bcd.curve.mappedGrade) {
        const q = `What letter grade does the professor map the class median to for ${bcd.name}? (e.g. B+)`;
        setPendingConfirmation(from, { type: 'norm_mapped_grade', data: { classKey: batchKey, median: bcd.curve.median }, question: q });
        console.log('SAVED PENDING:', 'norm_mapped_grade', batchKey);
        await sendMessage(from, q);
      } else {
        await showGrade(from, batchKey);
      }
    }
    return;
  }

  // ── Start a new class ─────────────────────────────────────────────────────
  if (action === 'new_class') {
    const className = intent.className || text.replace(/^new\s+class\s*[:\-]?\s*/i, '').trim();
    if (!className) {
      await sendMessage(from, 'What\'s the class name? (e.g. "new class: Bio 101")');
      return;
    }

    const classKey = className.toLowerCase();
    const existing = getClass(from, classKey);
    const hasCategories = !!(existing?.categories?.length);

    if (hasCategories) {
      const modeQuestion = `${className} already exists — start over and clear its grades, or just update the syllabus weights and keep grades? (restart/keep)`;
      setUserState(from, { step: 'idle', pendingClass: null });
      setPendingConfirmation(from, { type: 'new_class_mode', data: { className }, question: modeQuestion });
      console.log('SAVED PENDING:', 'new_class_mode', className);
      await sendMessage(from, modeQuestion);
    } else {
      setUserState(from, { step: 'awaiting_syllabus', pendingClass: className });
      await sendMessage(from, `Starting ${className}! Paste the grading breakdown from your syllabus.`);
    }
    return;
  }

  // ── Update syllabus for existing class ────────────────────────────────────
  if (action === 'update_syllabus') {
    const { classKey } = intent;
    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching that name. Use "new class: [name]" to add it.`);
      return;
    }
    setUserState(from, { step: 'awaiting_syllabus', pendingClass: classData.name });
    await sendMessage(
      from,
      `Paste the updated grading breakdown for ${classData.name}. Existing grades will be kept.`
    );
    return;
  }

  // ── Log a grade ───────────────────────────────────────────────────────────
  if (action === 'enter_grade') {
    const { classKey, categoryName, score } = intent;

    if (!classKey || score === undefined || score === null) {
      await sendMessage(from, 'Didn\'t catch the class, assignment, or score. Try: "got 85 on bio midterm"');
      return;
    }

    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching "${classKey}". Use "new class: [name]" to add it.`);
      return;
    }

    if (Number(score) < 0 || Number(score) > 150) {
      await sendMessage(from, `That score doesn't look right (${score}). Enter a number between 0 and 150.`);
      return;
    }

    const catKey = findCategoryKey(classData, categoryName);
    if (!catKey) {
      const names = classData.categories.map(c => c.name).join(', ');
      await sendMessage(from, `"${categoryName}" doesn't match any category in ${classData.name}.\nKnown: ${names}`);
      return;
    }

    const previousGrades = [...(classData.grades[catKey] || [])];
    classData.grades[catKey] = classData.grades[catKey] || [];
    classData.grades[catKey].push(Number(score));
    saveClass(from, classKey, classData);

    const catDisplay = classData.categories.find(c => c.name.toLowerCase() === catKey)?.name || catKey;
    saveLastAction(from, { type: 'grade_saved', classKey, className: classData.name, catKey, catDisplay, score: Number(score), previousGrades });

    await sendMessage(from, `Saved — ${score} on ${catDisplay} in ${classData.name}.`);
    return;
  }

  // ── Log a class average / median ─────────────────────────────────────────
  if (action === 'enter_class_average') {
    const { classKey, average } = intent;

    if (!classKey || average === undefined || average === null) {
      await sendMessage(from, 'Didn\'t catch the class or average. Try: "class average was 72 for data structures"');
      return;
    }

    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching "${classKey}".`);
      return;
    }

    const curveType = classData.curve?.type;

    if (curveType === 'mean') {
      const previousValue = classData.curve?.classAvg ?? null;
      classData.curve = { ...classData.curve, classAvg: Number(average) };
      saveClass(from, classKey, classData);
      saveLastAction(from, { type: 'class_average_saved', classKey, className: classData.name, field: 'curve.classAvg', previousValue, newValue: Number(average), label: 'class average' });
      await sendMessage(from, `Saved — class average ${average} for ${classData.name}.`);
      if (!intent._batchMode) await showGrade(from, classKey);
      return;
    }

    if (curveType === 'norm') {
      const previousValue = classData.curve?.median ?? null;
      classData.curve = { ...classData.curve, median: Number(average) };
      saveClass(from, classKey, classData);
      saveLastAction(from, { type: 'class_average_saved', classKey, className: classData.name, field: 'curve.median', previousValue, newValue: Number(average), label: 'class median' });
      await sendMessage(from, `Saved — class median ${average} for ${classData.name}.`);
      if (!intent._batchMode) {
        if (!classData.curve.mappedGrade) {
          const q = `What letter grade does the professor map that median to for ${classData.name}? (e.g. B+)`;
          setPendingConfirmation(from, { type: 'norm_mapped_grade', data: { classKey, median: Number(average) }, question: q });
          console.log('SAVED PENDING:', 'norm_mapped_grade', classKey);
          await sendMessage(from, q);
        } else {
          await showGrade(from, classKey);
        }
      }
      return;
    }

    // flat/none — store per-category for reference but it doesn't affect grade calc
    const catKey = findCategoryKey(classData, intent.categoryName);
    if (catKey) {
      classData.classAverages = classData.classAverages || {};
      const previousValue = classData.classAverages[catKey] ?? null;
      classData.classAverages[catKey] = Number(average);
      saveClass(from, classKey, classData);
      const catDisplay = classData.categories.find(c => c.name.toLowerCase() === catKey)?.name || catKey;
      saveLastAction(from, { type: 'class_average_saved', classKey, className: classData.name, field: `classAverages.${catKey}`, previousValue, newValue: Number(average), label: `${catDisplay} average` });
      await sendMessage(from, `Saved — class average of ${average} on ${catDisplay} in ${classData.name}.`);
    } else {
      await sendMessage(from, `${classData.name} has no active curve — class averages don't affect the grade calculation.`);
    }
    if (!intent._batchMode) await showGrade(from, classKey);
    return;
  }

  // ── Check grade ───────────────────────────────────────────────────────────
  if (action === 'check_grade') {
    let classKey = intent.classKey;

    if (!classKey) {
      const all = getAllClasses(from);
      const keys = Object.keys(all);
      if (keys.length === 1) {
        classKey = keys[0];
      } else if (keys.length === 0) {
        await sendMessage(from, 'No classes yet! Add one with "new class: [name]"');
        return;
      } else {
        const names = Object.values(all).map(c => c.name).join(', ');
        await sendMessage(from, `Which class? You have: ${names}`);
        return;
      }
    }

    await showGrade(from, classKey);
    return;
  }

  // ── Show all ──────────────────────────────────────────────────────────────
  if (action === 'show_all') {
    await showAllGrades(from);
    return;
  }

  // ── Sync Canvas ───────────────────────────────────────────────────────────
  if (action === 'sync_canvas') {
    const token = process.env.CANVAS_TOKEN;
    const baseUrl = process.env.CANVAS_BASE_URL;

    if (!token || !baseUrl) {
      await sendMessage(from, 'Canvas isn\'t connected. Text "connect canvas" to link it.');
      return;
    }

    const canvasClasses = Object.keys(getAllClasses(from)).filter(k => getClass(from, k)?.canvasId);
    if (canvasClasses.length === 0) {
      await sendMessage(from, 'No classes are linked to Canvas yet. Add a class first — it will ask about Canvas after the syllabus is set up.');
      return;
    }

    await sendMessage(from, 'Syncing from Canvas...');
    await performCanvasSync(from, canvasClasses);
    return;
  }

  // ── Connect Canvas ────────────────────────────────────────────────────────
  if (action === 'connect_canvas') {
    // "connect canvas" with no active class: ask which class they want to link
    const all = getAllClasses(from);
    const unlinked = Object.entries(all).filter(([, c]) => !c.canvasId).map(([, c]) => c.name);

    if (unlinked.length === 0 && Object.keys(all).length > 0) {
      await sendMessage(from, 'All your classes are already linked to Canvas. Text "sync canvas" to update grades.');
      return;
    }

    if (Object.keys(all).length === 0) {
      await sendMessage(from, 'No classes yet. Add one with "new class: [name]" — it will ask about Canvas after the syllabus is set up.');
      return;
    }

    // If only one class, go straight to Canvas choice for it
    if (unlinked.length === 1) {
      const className = unlinked[0];
      await offerCanvas(from, className, '');
      return;
    }

    // Multiple unlinked — which class?
    const nameList = unlinked.map((n, i) => `${i + 1}. ${n}`).join('\n');
    await sendMessage(from, `Which class do you want to link to Canvas?\n${nameList}\n\nText "new class: [name]" and say yes when asked about Canvas.`);
    return;
  }

  // ── Delete a class ────────────────────────────────────────────────────────
  if (action === 'delete_class') {
    const { classKey } = intent;
    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, 'No class found with that name.');
      return;
    }
    const deleteQuestion = `Delete ${classData.name} and all its grades? (yes/no)`;
    setUserState(from, { step: 'idle', pendingClass: null });
    setPendingConfirmation(from, { type: 'confirm_delete', data: { classKey }, question: deleteQuestion });
    console.log('SAVED PENDING:', 'confirm_delete', classKey);
    await sendMessage(from, deleteQuestion);
    return;
  }

  // ── Reset everything ──────────────────────────────────────────────────────
  if (action === 'reset') {
    const resetQuestion = 'Are you sure? This will delete all your classes and grades.\n\n1 – Yes, keep Canvas connected\n2 – Yes, and disconnect Canvas\n3 – Cancel';
    setUserState(from, { step: 'idle', pendingClass: null });
    setPendingConfirmation(from, { type: 'confirm_reset', data: {}, question: resetQuestion });
    console.log('SAVED PENDING:', 'confirm_reset');
    await sendMessage(from, resetQuestion);
    return;
  }

  // ── Help ──────────────────────────────────────────────────────────────────
  if (action === 'help') {
    const config = getConfig(from);
    const canvasLine = config.canvasConnected
      ? '• "sync canvas" — pull latest scores from Canvas'
      : '• Canvas sync is offered automatically after setting up a new class';

    await sendMessage(
      from,
      'grade-brain commands:\n' +
        '• "new class: Bio 101" — add a class (will ask for syllabus)\n' +
        '• "got 85 on bio midterm" — log a grade manually\n' +
        '• "class average was 71 on bio midterm" — log class avg (for curves)\n' +
        '• "what\'s my grade in bio?" — check grade\n' +
        '• "show all my grades" — see everything\n' +
        '• "update syllabus for bio" — update weights, keep grades\n' +
        '• "delete bio" — remove a class\n' +
        '• "bio is 3 credits" — set credit hours\n' +
        '• "my GPA" — see semester GPA\n' +
        canvasLine
    );
    return;
  }

  // ── Undo last action ─────────────────────────────────────────────────────
  if (action === 'undo') {
    const last = getLastAction(from);
    if (!last) {
      await sendMessage(from, 'Nothing to undo yet.');
      return;
    }
    const description = describeAction(last);
    const q = `Undo ${description}? (yes/no)`;
    setPendingConfirmation(from, { type: 'confirm_undo', data: { last }, question: q });
    console.log('SAVED PENDING:', 'confirm_undo');
    await sendMessage(from, q);
    return;
  }

  // ── Show semester GPA ─────────────────────────────────────────────────────
  if (action === 'show_gpa') {
    const all = getAllClasses(from);
    if (Object.keys(all).length === 0) {
      await sendMessage(from, 'No classes yet. Add one with "new class: [name]".');
      return;
    }

    const { gpa, included, missing, noGrades } = calcGPA(all);

    let msg = '';

    if (included.length > 0) {
      const lines = included.map(c => `• ${c.name}: ${c.letter} (${c.creditHours} cr)`).join('\n');
      msg += `Semester GPA: ${gpa}\n\n${lines}`;
    }

    if (missing.length > 0) {
      const names = missing.join(', ');
      msg += `${msg ? '\n\n' : ''}Credit hours missing for: ${names}\nText "[class] is [N] credits" to set them.`;
    }

    if (noGrades.length > 0 && included.length === 0 && missing.length === 0) {
      msg = 'No grades entered yet — add some grades first.';
    }

    await sendMessage(from, msg);
    return;
  }

  // ── Set credit hours for a class ─────────────────────────────────────────
  if (action === 'set_credits') {
    const { classKey, credits } = intent;
    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching that name.`);
      return;
    }
    if (!credits || credits < 0 || credits > 12) {
      await sendMessage(from, 'Enter a credit hour count between 1 and 12.');
      return;
    }
    classData.creditHours = Number(credits);
    saveClass(from, classKey, classData);
    await sendMessage(from, `Set ${classData.name} to ${credits} credit hour${credits !== 1 ? 's' : ''}. Text "my GPA" to see your semester GPA.`);
    return;
  }

  // ── Set norm curve letter without a numeric median ────────────────────────
  if (action === 'set_norm_letter') {
    const { classKey, letter } = intent;
    const VALID = ['A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'C-', 'D', 'F'];
    const upperLetter = letter?.toUpperCase();

    if (!classKey) {
      await sendMessage(from, 'Which class? Try: "data structures median is B+"');
      return;
    }
    if (!upperLetter || !VALID.includes(upperLetter)) {
      await sendMessage(from, `That doesn't look like a valid letter grade. Options: ${VALID.join(', ')}`);
      return;
    }

    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching "${classKey}".`);
      return;
    }
    if (classData.curve?.type !== 'norm') {
      await sendMessage(from, `${classData.name} doesn't use a norm-referenced curve.`);
      return;
    }

    const q = `What was the numeric median score for ${classData.name}? (e.g. 72 — or "skip" if there's no number)`;
    setPendingConfirmation(from, { type: 'awaiting_numeric_median', data: { classKey, letter: upperLetter }, question: q });
    console.log('SAVED PENDING:', 'awaiting_numeric_median', classKey);
    await sendMessage(from, q);
    return;
  }

  // ── Hypothetical grade ────────────────────────────────────────────────────
  if (action === 'hypothetical_grade') {
    const { classKey, categoryName, score } = intent;

    if (!classKey || score === undefined || score === null) {
      await sendMessage(from, 'Try: "what would my grade be if I got 85 on the bio final?"');
      return;
    }

    if (Number(score) < 0 || Number(score) > 150) {
      await sendMessage(from, `That score doesn't look right (${score}). Enter a number between 0 and 150.`);
      return;
    }

    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching "${classKey}".`);
      return;
    }

    const catKey = findCategoryKey(classData, categoryName);
    if (!catKey) {
      const names = classData.categories.map(c => c.name).join(', ');
      await sendMessage(from, `"${categoryName}" doesn't match any category in ${classData.name}.\nKnown: ${names}`);
      return;
    }

    const clone = JSON.parse(JSON.stringify(classData)) as ClassData;
    clone.grades[catKey] = clone.grades[catKey] || [];
    clone.grades[catKey].push(Number(score));

    const result = calcCurrentGrade(clone);
    if (!result) {
      await sendMessage(from, 'Not enough grade data to project.');
      return;
    }

    const catDisplay = classData.categories.find(c => c.name.toLowerCase() === catKey)?.name || catKey;
    const gradeStr = result.curvedLetter
      ? `${result.curvedGrade}% ${result.curvedLetter} (curved)`
      : `${result.rawGrade}% ${getLetterGrade(result.rawGrade)}`;

    await sendMessage(from, `If you get ${score} on ${catDisplay} in ${classData.name}:\n${gradeStr}`);
    return;
  }

  // ── Delete a single grade ─────────────────────────────────────────────────
  if (action === 'delete_grade') {
    const { classKey, categoryName, score } = intent;

    if (!classKey) {
      await sendMessage(from, 'Try: "remove my 45 on bio midterm"');
      return;
    }

    const classData = getClass(from, classKey);
    if (!classData) {
      await sendMessage(from, `No class matching "${classKey}".`);
      return;
    }

    const catKey = findCategoryKey(classData, categoryName);
    if (!catKey) {
      const names = classData.categories.map(c => c.name).join(', ');
      await sendMessage(from, `"${categoryName}" doesn't match any category in ${classData.name}.\nKnown: ${names}`);
      return;
    }

    const manualGrades = classData.grades[catKey] || [];
    if (manualGrades.length === 0) {
      const hasCanvas = (classData.canvasGrades?.[catKey] || []).length > 0;
      if (hasCanvas) {
        await sendMessage(from, `No manual grades to delete for ${catKey} — those scores came from Canvas. Sync Canvas again if a score was wrong.`);
      } else {
        await sendMessage(from, `No grades entered for ${catKey} in ${classData.name}.`);
      }
      return;
    }

    const previousGrades = [...manualGrades];
    let removed: number | undefined;

    if (score !== undefined && score !== null) {
      const idx = manualGrades.indexOf(Number(score));
      if (idx === -1) {
        await sendMessage(from, `Couldn't find a grade of ${score} in ${catKey} for ${classData.name}.\nGrades on record: ${manualGrades.join(', ')}`);
        return;
      }
      removed = manualGrades.splice(idx, 1)[0];
    } else {
      removed = manualGrades.pop();
    }

    if (removed === undefined) return;

    classData.grades[catKey] = manualGrades;
    saveClass(from, classKey, classData);

    const catDisplay = classData.categories.find(c => c.name.toLowerCase() === catKey)?.name || catKey;
    saveLastAction(from, { type: 'grade_deleted', classKey, className: classData.name, catKey, catDisplay, removedScore: removed, previousGrades });

    await sendMessage(from, `Removed ${removed} from ${catDisplay} in ${classData.name}.`);
    await showGrade(from, classKey);
    return;
  }

  // ── Manual entry hint ─────────────────────────────────────────────────────
  if (action === 'enter_manually') {
    const classData = intent.classKey ? getClass(from, intent.classKey) : null;
    const className = classData?.name || (intent.classKey ? intent.classKey : null);
    const example = className
      ? `"got an 88 on the midterm for ${className}"`
      : `"got an 88 on the bio midterm"`;
    await sendMessage(from, `Sure — text your grade like:\n${example}`);
    return;
  }

  // ── Confirm a guessed intent ──────────────────────────────────────────────
  if (action === 'confirm') {
    const { guess, confirmedIntent } = intent;
    setUserState(from, { step: 'idle', pendingClass: null });
    setPendingConfirmation(from, { type: 'confirm_intent', data: { intent: confirmedIntent }, question: guess });
    console.log('SAVED PENDING:', 'confirm_intent', guess);
    await sendMessage(from, `${guess} (yes/no)`);
    return;
  }

  // If the message looks like a plain number, check for norm classes missing a median
  const numericInput = parseFloat(text);
  if (!isNaN(numericInput) && numericInput >= 0 && numericInput <= 150 && /^\d+(\.\d+)?$/.test(text)) {
    const all = getAllClasses(from);
    const normNoMedian = Object.entries(all).filter(([, c]) => c.curve?.type === 'norm' && c.curve?.median == null);

    if (normNoMedian.length === 1) {
      const [classKey, classData] = normNoMedian[0];
      const q = `Is ${numericInput} the class median for ${classData.name}? (yes/no)`;
      setPendingConfirmation(from, { type: 'norm_median_from_number', data: { classKey, num: numericInput }, question: q });
      console.log('SAVED PENDING:', 'norm_median_from_number', classKey);
      await sendMessage(from, q);
      return;
    }

    if (normNoMedian.length > 1) {
      const list = normNoMedian.map(([, c], i) => `${i + 1}. ${c.name}`).join('\n');
      setPendingConfirmation(from, { type: 'norm_median_class_choice', data: { num: numericInput, classes: normNoMedian.map(([k, c]) => ({ classKey: k, name: c.name })) }, question: list });
      console.log('SAVED PENDING:', 'norm_median_class_choice');
      await sendMessage(from, `Which class is ${numericInput} the median for?\n${list}`);
      return;
    }
  }

  await sendMessage(from, "I'm not sure what you meant. Text \"help\" to see all commands.");
}

// ─── Canvas Sync Engine ───────────────────────────────────────────────────────

/**
 * Sync Canvas scores for one or more classes (identified by their storage keys).
 */
async function performCanvasSync(from: string, classKeys: string[]): Promise<void> {
  const token = process.env.CANVAS_TOKEN;
  const baseUrl = process.env.CANVAS_BASE_URL;
  const allAmbiguous: Array<{ classKey: string; assignment: CanvasAssignment }> = [];
  let totalSynced = 0;
  const totalUngraded = 0;

  for (const classKey of classKeys) {
    const classData = getClass(from, classKey);
    if (!classData?.canvasId) continue;

    let scored: CanvasAssignment[];
    try {
      scored = await getScoredAssignments(baseUrl || '', token || '', classData.canvasId);
    } catch (err) {
      const e = err as { message?: string; code?: string };
      if (e.message === 'CANVAS_AUTH_ERROR') {
        await sendMessage(
          from,
          'Canvas token expired. Generate a new one:\nCanvas → Account → Settings → Approved Integrations → New Access Token\n\nThen text "connect canvas" to reconnect.'
        );
        return;
      }
      if (e.code === 'ECONNABORTED') {
        await sendMessage(from, 'Canvas took too long to respond. Try "sync canvas" again in a moment.');
        return;
      }
      console.error(`Canvas fetch error for ${classKey}:`, e.message);
      continue;
    }

    const map: Record<string, string | null> = classData.canvasAssignmentMap || {};

    // Separate known assignments from new ones
    const known = scored.filter(a => a.id in map);
    const unclassified = scored.filter(a => !(a.id in map));

    // Auto-classify the unclassified batch in one Claude call
    let newMappings: Record<string, { catKey: string | null; confident: boolean }> = {};
    if (unclassified.length > 0) {
      newMappings = await batchMatchAssignments(unclassified, classData.categories);
    }

    // Rebuild Canvas grade arrays from scratch (handles score updates correctly).
    // Manual grades live in classData.grades and are never touched here.
    const newCanvasGrades: Record<string, number[]> = {};
    for (const cat of classData.categories) {
      newCanvasGrades[cat.name.toLowerCase()] = [];
    }

    // Apply known mappings
    for (const a of known) {
      const catKey = map[a.id];
      if (catKey !== null && newCanvasGrades[catKey] !== undefined) {
        newCanvasGrades[catKey].push(a.percentage);
        totalSynced++;
      }
    }

    const ADMIN_PATTERNS = [
      /late\s*days?/i,
      /attendance/i,
      /participation/i,
      /extra\s*credit/i,
      /higher\s*(midterm|exam)/i,   // Canvas tracking best-midterm internally
      /better\s*(midterm|exam)/i,
      /best\s*(midterm|exam)/i,
    ];

    // Apply new confident matches; queue ambiguous ones
    for (const a of unclassified) {
      const result = newMappings[a.name] || { catKey: null, confident: false };
      const catKeyValid = result.catKey && newCanvasGrades[result.catKey] !== undefined;

      if (result.confident && catKeyValid) {
        map[a.id] = result.catKey;
        newCanvasGrades[result.catKey!].push(a.percentage);
        totalSynced++;
      } else {
        const isAdmin = ADMIN_PATTERNS.some(p => p.test(a.groupName) || p.test(a.name));
        const isInvalidScore = a.percentage > 150;
        if (isAdmin || isInvalidScore) {
          map[a.id] = null; // auto-skip silently
        } else {
          allAmbiguous.push({ classKey, assignment: a });
        }
      }
    }

    classData.canvasGrades = newCanvasGrades;
    classData.canvasAssignmentMap = map;
    classData.lastSyncedAt = new Date().toISOString();
    saveClass(from, classKey, classData);
  }

  // Report sync results
  const ambiguousToAsk = allAmbiguous.slice(0, MAX_CLARIFY);
  const autoSkipped = allAmbiguous.length - ambiguousToAsk.length;

  if (totalSynced === 0 && ambiguousToAsk.length === 0) {
    // Nothing graded yet in Canvas
    if (classKeys.length === 1) {
      const className = getClass(from, classKeys[0])?.name || classKeys[0];
      const q = `No graded assignments found in Canvas for ${className} yet. I'll show grades here as soon as your professor posts them.\n\nWant to enter any grades manually in the meantime? (yes/no)`;
      setPendingConfirmation(from, { type: 'manual_entry_offer', data: { classKey: classKeys[0] }, question: q });
      console.log('SAVED PENDING:', 'manual_entry_offer', classKeys[0]);
      await sendMessage(from, q);
    } else {
      await sendMessage(from, `No graded assignments found yet. I'll update automatically when Canvas has scores.`);
    }
  } else {
    let reply = `Synced ${totalSynced} assignment${totalSynced !== 1 ? 's' : ''}.`;
    if (totalUngraded > 0) reply += ` (${totalUngraded} ungraded skipped)`;
    const exampleClass = getClass(from, classKeys[0])?.name || classKeys[0];
    reply += `\n\nYou can also add grades manually for anything Canvas hasn't posted yet — e.g. "got 88 on midterm for ${exampleClass}"`;
    await sendMessage(from, reply);

    if (classKeys.length === 1) {
      await showGrade(from, classKeys[0]);
    } else {
      await showAllGrades(from);
    }
  }

  if (ambiguousToAsk.length > 0) {
    // Kick off classification flow
    const first = ambiguousToAsk[0];
    const rest = ambiguousToAsk.slice(1);
    const firstClassData = getClass(from, first.classKey);

    setUserState(from, {
      step: 'awaiting_assignment_classification',
      pendingClass: JSON.stringify({
        classKey: first.classKey,
        current: first.assignment,
        queue: rest.map(x => ({ ...x.assignment, classKey: x.classKey })),
        skippedCount: autoSkipped,
      }),
    });

    if (firstClassData) {
      await askAboutAssignment(from, firstClassData, first.assignment, rest.length + autoSkipped);
    }
  }
}

// ─── Grade Display ────────────────────────────────────────────────────────────

async function showGrade(from: string, classKey: string): Promise<void> {
  const classData = getClass(from, classKey);

  if (!classData) {
    await sendMessage(from, 'No class found. Use "new class: [name]" to add one.');
    return;
  }
  if (!classData.categories?.length) {
    await sendMessage(from, `${classData.name} has no grading categories yet.`);
    return;
  }

  const result = calcCurrentGrade(classData);
  if (!result) {
    const hint = classData.canvasSynced ? ' (try "sync canvas")' : '';
    await sendMessage(from, `No grades entered for ${classData.name} yet!${hint}`);
    return;
  }

  const { rawGrade, curvedGrade, curvedLetter, curvePending, curveNoShift, curveNote, completedWeight, breakdown } = result;
  const totalWeight = classData.categories.reduce((s, c) => s + c.weight, 0);
  const remainingWeight = totalWeight - completedWeight;
  const hasCurve = classData.curve?.type && classData.curve.type !== 'none';

  const catLines = breakdown.map(b => {
    const weightStr = b.weightNote ? `${b.weight}% — ${b.weightNote}` : `${b.weight}%`;
    let line = `${b.name} (${weightStr}): ${b.rawAvg}%`;
    if (b.count > 1) line += ` (avg of ${b.count})`;
    if (b.droppedCount > 0) line += ` (${b.droppedCount} lowest dropped)`;
    return line;
  });

  const targets = [
    { pct: 93, label: 'A' },
    { pct: 90, label: 'A-' },
    { pct: 87, label: 'B+' },
    { pct: 83, label: 'B' },
    { pct: 80, label: 'B-' },
    { pct: 73, label: 'C' },
  ];

  const neededLines: string[] = [];
  if (remainingWeight > 0) {
    if (classData.curve?.type === 'norm') {
      neededLines.push('Projection unavailable — final letter grade depends on where the class median lands.');
    } else {
      for (const t of targets) {
        const needed = calcNeeded(classData, t.pct);
        if (needed === null) break;
        if (needed <= 0) { neededLines.push(`${t.label}: guaranteed`); break; }
        if (needed > 100) { neededLines.push(`${t.label}: not possible (need ${needed})`); break; }
        neededLines.push(`${t.label}: need ${needed} on remaining ${remainingWeight}%`);
      }
    }
  }

  let msg = `${classData.name}\n`;
  if (hasCurve) {
    if (curveNoShift) {
      msg += `Grade: ${rawGrade}% ${getLetterGrade(rawGrade)}\n`;
      msg += `Curve: ${curveNote}\n`;
    } else if (curvedLetter && curvedGrade !== rawGrade) {
      // Curve changes the numeric grade (flat/mean) — show both
      msg += `Raw: ${rawGrade}% ${getLetterGrade(rawGrade)}\n`;
      msg += `Curved: ${curvedGrade}% ${curvedLetter} — ${curveNote}\n`;
    } else if (curvedLetter) {
      // Norm curve — number unchanged, only letter changes
      msg += `Curved: ${rawGrade}% ${curvedLetter} — ${curveNote}\n`;
    } else if (curvePending) {
      msg += `Grade: ${rawGrade}% ${getLetterGrade(rawGrade)}\n`;
      msg += `Curve pending — ${curveNote}\n`;
    }
  } else {
    msg += `Grade: ${rawGrade}% ${getLetterGrade(rawGrade)}\n`;
  }
  msg += `(${completedWeight}% of grade entered)\n\n`;
  msg += catLines.join('\n');

  if (remainingWeight > 0) {
    const best = calcBestPossible(classData);
    if (best) {
      const bestStr = best.curvedLetter
        ? `${best.curvedGrade}% ${best.curvedLetter}`
        : `${best.rawGrade}% ${getLetterGrade(best.rawGrade)}`;
      msg += `\n\nBest possible: ${bestStr}`;
    }
  }

  if (neededLines.length) msg += '\n\nTo earn:\n' + neededLines.join('\n');

  if (classData.lastSyncedAt) msg += `\n\nLast synced: ${timeAgo(classData.lastSyncedAt)}`;

  await sendMessage(from, msg);
}

async function showAllGrades(from: string): Promise<void> {
  const classes = getAllClasses(from);
  const keys = Object.keys(classes);

  if (keys.length === 0) {
    await sendMessage(from, 'No classes yet! Text "new class: [name]" to add one.');
    return;
  }

  const lines = keys.map(key => {
    const c = classes[key];
    const result = calcCurrentGrade(c);
    const badge = c.canvasSynced ? ' [Canvas]' : '';
    if (!result) return `${c.name}${badge}: no grades yet`;
    const { rawGrade, curvedGrade, curvedLetter, completedWeight } = result;
    const displayGrade = curvedLetter ? `${curvedGrade}% ${curvedLetter}` : `${rawGrade}% ${getLetterGrade(rawGrade)}`;
    return `${c.name}${badge}: ${displayGrade} (${completedWeight}% graded)`;
  });

  await sendMessage(from, 'All classes:\n' + lines.join('\n'));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function describeAction(last: LastAction): string {
  switch (last.type) {
    case 'grade_saved':         return `adding ${last.score} to ${last.catDisplay} in ${last.className}`;
    case 'grade_deleted':       return `removing ${last.removedScore} from ${last.catDisplay} in ${last.className}`;
    case 'class_average_saved': return `saving ${last.label} for ${last.className}`;
    case 'norm_grade_saved':    return `setting norm curve letter to ${last.newValue} for ${last.className}`;
    case 'class_added':         return `adding ${last.className}`;
    case 'syllabus_updated':    return `updating syllabus weights for ${last.className}`;
    case 'canvas_linked':       return `linking Canvas to ${last.className}`;
    default:                    return 'last action';
  }
}

function timeAgo(isoString: string): string {
  const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Save a parsed syllabus result and move the conversation forward.
 * Called by both the text path and the photo path so the logic is identical.
 */
async function processParsedSyllabus(from: string, pendingClass: string | null, parsed: { categories: ClassData['categories']; dynamicWeights?: ClassData['dynamicWeights']; notes?: string }, forceRestart = false): Promise<void> {
  const classKey = (pendingClass || '').toLowerCase();
  const existing = getClass(from, classKey);
  const isUpdate = !forceRestart && !!(existing?.categories?.length);

  const classData: ClassData = {
    name: pendingClass || classKey,
    categories: parsed.categories,
    grades: {},
    classAverages: isUpdate ? (existing!.classAverages || {}) : {},
    curve: isUpdate ? (existing!.curve || { type: 'none' }) : { type: 'none' },
    dynamicWeights: parsed.dynamicWeights || (isUpdate ? (existing!.dynamicWeights || null) : null),
    canvasSynced: isUpdate ? (existing!.canvasSynced || false) : false,
    canvasId: isUpdate ? (existing!.canvasId || null) : null,
    canvasAssignmentMap: {},
  };

  for (const cat of parsed.categories) {
    const key = cat.name.toLowerCase();
    classData.grades[key] = isUpdate ? (existing!.grades[key] || []) : [];
  }

  if (isUpdate) {
    saveLastAction(from, { type: 'syllabus_updated', classKey, className: pendingClass || classKey, previousClassData: JSON.parse(JSON.stringify(existing!)) as ClassData });
  }

  saveClass(from, classKey, classData);

  if (!isUpdate) {
    saveLastAction(from, { type: 'class_added', classKey, className: pendingClass || classKey });
  }

  const catLines = parsed.categories.map(c => `• ${c.name}: ${c.weight}%`).join('\n');
  const note = parsed.notes ? `\n(${parsed.notes})` : '';
  const weightSum = parsed.categories.reduce((s, c) => s + c.weight, 0);
  const weightWarning = Math.round(weightSum) !== 100
    ? `\n\nNote: these weights add up to ${weightSum}%, not 100%. If something looks off, text "update syllabus for ${pendingClass}" to fix it.`
    : '';

  if (isUpdate) {
    setUserState(from, { step: 'idle', pendingClass: null });
    const syncNote = classData.canvasSynced
      ? '\n\nCanvas map cleared — text "sync canvas" to re-match scores to the new categories.'
      : '';
    await sendMessage(
      from,
      `Updated ${pendingClass} weights:\n${catLines}${note}${weightWarning}\n\nExisting grades were kept.${syncNote}`
    );
  } else {
    const curveQuestion = `Here's what I found for ${pendingClass}:\n${catLines}${note}${weightWarning}\n\nDoes it have a curve?\n1 – Flat points added to all scores\n2 – Scale to class mean\n3 – Norm-referenced (median mapped to a letter grade)\n4 – No curve`;
    setUserState(from, { step: 'idle', pendingClass: null });
    setPendingConfirmation(from, { type: 'curve_type', data: { className: pendingClass || classKey }, question: curveQuestion });
    console.log('SAVED PENDING:', 'curve_type', pendingClass);
    await sendMessage(from, curveQuestion);
  }
}

/**
 * Called when curve setup finishes. Transitions to the "want Canvas?" question.
 */
async function offerCanvas(from: string, className: string, note: string): Promise<void> {
  const config = getConfig(from);
  const prefix = note ? `${note}\n\n` : '';
  const question = config.canvasConnected
    ? `${prefix}${className} is all set! Want to sync grades from Canvas for this class? (yes/no)`
    : `${prefix}${className} is all set! Want to connect Canvas to auto-sync scores? (yes/no)`;

  setUserState(from, { step: 'idle', pendingClass: null });
  setPendingConfirmation(from, { type: 'canvas_choice', data: { className }, question });
  console.log('SAVED PENDING:', 'canvas_choice', className);
  await sendMessage(from, question);
}

/**
 * Fetch Canvas courses and present a numbered list so the user can identify
 * which one corresponds to the class being set up.
 */
async function pickCanvasCourse(from: string, className: string): Promise<void> {
  const token = process.env.CANVAS_TOKEN;
  const baseUrl = process.env.CANVAS_BASE_URL;

  let courses: CanvasCourse[];
  try {
    courses = await getCourses(baseUrl || '', token || '');
  } catch (err) {
    const e = err as { message?: string };
    if (e.message === 'CANVAS_AUTH_ERROR') {
      await sendMessage(from, 'Canvas token expired. Text "connect canvas" to reconnect.');
      setUserState(from, { step: 'idle', pendingClass: null });
      return;
    }
    throw err;
  }

  if (courses.length === 0) {
    await sendMessage(from, 'No active Canvas courses found. Skipping Canvas sync for now.');
    setUserState(from, { step: 'idle', pendingClass: null });
    return;
  }

  const courseList = courses.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
  const courseQuestion = `Which Canvas course is "${className}"?\n\n${courseList}\n\nReply with the number, or "skip".`;
  setUserState(from, { step: 'idle', pendingClass: null });
  setPendingConfirmation(from, { type: 'canvas_course', data: { className, courses }, question: courseQuestion });
  console.log('SAVED PENDING:', 'canvas_course', className);
  await sendMessage(from, courseQuestion);
}

/**
 * Send the classification question for one ambiguous Canvas assignment.
 */
async function askAboutAssignment(from: string, classData: ClassData, assignment: CanvasAssignment, remainingCount: number): Promise<void> {
  const catNames = classData.categories.map(c => c.name).join(', ');
  const queueNote = remainingCount > 0 ? ` (${remainingCount} more after this)` : '';

  await sendMessage(
    from,
    `I found an assignment I couldn't categorize${queueNote}:\n\n"${assignment.name}" — Canvas group: ${assignment.groupName}, score: ${assignment.percentage}%\n\nWhich category does this count toward?\n${catNames}\n\nOr reply "skip".`
  );
}

/**
 * Fuzzy-match a category name to its lowercase storage key.
 * "midterm" matches "Midterm Exam", "hw" matches "Homework".
 */
function findCategoryKey(classData: ClassData, categoryName: string | undefined): string | null {
  if (!categoryName) return null;
  const lower = categoryName.toLowerCase();

  for (const cat of classData.categories) {
    const key = cat.name.toLowerCase();
    if (key === lower || key.includes(lower) || lower.includes(key)) {
      return key;
    }
  }
  return null;
}
