// claude.js — All calls to the Anthropic Claude API
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

/**
 * Low-level helper: send a prompt to Claude and get back a text response.
 *
 * @param {string} systemPrompt - Instructions telling Claude how to behave
 * @param {string} userMessage  - The actual input to process
 * @returns {string} Claude's text response
 */
async function askClaude(systemPrompt, userMessage) {
  const response = await axios.post(
    CLAUDE_URL,
    {
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data.content[0].text;
}

/**
 * Parse a syllabus grading section from an image using Claude vision.
 * The caller is responsible for downloading the image and passing base64 + mediaType.
 *
 * @param {string} base64Data - Base64-encoded image data
 * @param {string} mediaType  - MIME type (e.g. 'image/jpeg', 'image/png')
 * @param {string} className  - Class name for context
 * @returns {{ categories: Array<{name, weight}>, notes: string } | null}
 */
// Shared prompt for both image parsing functions
const IMAGE_PROMPT = (className) =>
  `Extract the grading breakdown from this syllabus image${className ? ` for ${className}` : ''}.

Return ONLY valid JSON (no markdown):
{
  "categories": [{ "name": "Category Name", "weight": 25 }],
  "notes": "brief note if anything is ambiguous"
}

Weights are plain numbers (30 means 30%) and should sum to 100.`;

/**
 * Parse a syllabus image by passing its URL directly to Claude.
 * Simplest approach — no download needed if the URL is publicly accessible.
 */
export async function parseSyllabusFromUrl(imageUrl, className) {
  if (process.env.TEST_MODE === 'true') return null;

  const response = await axios.post(
    CLAUDE_URL,
    {
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: imageUrl } },
          { type: 'text', text: IMAGE_PROMPT(className) },
        ],
      }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  const text = response.data.content[0].text;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('parseSyllabusFromUrl: failed to parse JSON:', text);
  }
  return null;
}

/**
 * Parse a syllabus image from a pre-downloaded base64 buffer.
 * Used as a fallback when the URL requires auth headers to download.
 */
export async function parseSyllabusFromImage(base64Data, mediaType, className) {
  if (process.env.TEST_MODE === 'true') return null;

  const response = await axios.post(
    CLAUDE_URL,
    {
      model: MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data },
          },
          { type: 'text', text: IMAGE_PROMPT(className) },
        ],
      }],
    },
    {
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  const text = response.data.content[0].text;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('parseSyllabusFromImage: failed to parse JSON:', text);
  }
  return null;
}

/**
 * Parse a messy syllabus grading section into structured categories.
 *
 * @param {string} className    - Name of the class (for context)
 * @param {string} syllabusText - Raw text from the grading section of the syllabus
 * @returns {{ categories: Array<{name: string, weight: number}>, notes: string } | null}
 *   categories: array of {name, weight} where weight is a percentage (e.g. 30 for 30%)
 *   null if parsing fails
 */
export async function parseSyllabus(className, syllabusText) {
  // ── Offline mock for TEST_MODE ────────────────────────────────────────────
  if (process.env.TEST_MODE === 'true') {
    // Handles formats like: "Midterm 30%", "Final Exam: 40%", "Lab Reports - 20%"
    const categories = [];
    const re = /([A-Za-z][A-Za-z ]*?)\s*[:\-]?\s*(\d+)\s*%/g;
    let m;
    while ((m = re.exec(syllabusText)) !== null) {
      categories.push({ name: m[1].trim(), weight: Number(m[2]) });
    }
    return categories.length ? { categories, notes: '' } : null;
  }
  // ── Real Claude call ──────────────────────────────────────────────────────
  const system = `You are a syllabus parser. Extract grading categories and their percentage weights from syllabus text.

Return ONLY valid JSON with this exact structure (no markdown, no explanation):
{
  "categories": [
    { "name": "Category Name", "weight": 25 }
  ],
  "dynamicWeights": null,
  "notes": "brief note if weights are ambiguous or don't add to 100"
}

Rules:
- weights are plain numbers (30 means 30%)
- they should sum to 100; if they don't, note it and make your best guess
- use clean display names (e.g. "Midterm Exam" not "EXAM1 (midterm)")
- if the syllabus lists sub-components (hw1, hw2...) group them under one category
- if the syllabus says the BETTER or HIGHER of two exams counts for more (e.g. "the higher midterm counts for 25%, the lower for 20%"), detect this as a best/worst rule:
  set each dynamic category's weight in "categories" to the average of bestWeight and worstWeight
  set "dynamicWeights" to: { "type": "best_worst", "categoryA": "exact name", "categoryB": "exact name", "bestWeight": 25, "worstWeight": 20 }
  if no best/worst rule exists, set "dynamicWeights" to null
- if a category says "drop the lowest N" or "lowest N dropped" or similar, add "dropLowest": N to that category object (e.g. { "name": "Homework", "weight": 20, "dropLowest": 1 }); omit dropLowest entirely if not mentioned`;

  const raw = await askClaude(system, `Class: ${className}\n\nSyllabus text:\n${syllabusText}`);

  try {
    // Claude sometimes wraps JSON in markdown code blocks — strip them
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('parseSyllabus: failed to parse JSON from:', raw);
  }

  return null;
}

/**
 * Classify what the user wants to do and extract the relevant details.
 *
 * @param {string} message  - The user's raw iMessage text
 * @param {object} classes  - Current classes object from storage (key → classData)
 * @returns {object} An intent object — shape depends on the action field
 */
export async function classifyIntent(message, classes) {
  // ── Offline mock for TEST_MODE ────────────────────────────────────────────
  if (process.env.TEST_MODE === 'true') {
    return mockClassifyIntent(message, classes);
  }
  // ── Real Claude call ──────────────────────────────────────────────────────
  // Build a list of known class keys and names to help Claude match
  const classInfo = Object.entries(classes)
    .map(([key, c]) => {
      const cats = c.categories?.map(cat => cat.name).join(', ') || 'no categories yet';
      return `  key="${key}" name="${c.name}" categories=[${cats}]`;
    })
    .join('\n');

  const system = `You are the intent parser for a grade tracking bot. Classify the user's message into one of these actions and extract the relevant data.

Known classes:
${classInfo || '  (none yet)'}

Actions and their JSON shapes:
- new_class:           { "action": "new_class", "className": "Bio 101" }
- enter_grade:         { "action": "enter_grade", "classKey": "bio 101", "categoryName": "midterm", "score": 85 }
- enter_class_average: { "action": "enter_class_average", "classKey": "bio 101", "categoryName": "midterm", "average": 71 }
- check_grade:         { "action": "check_grade", "classKey": "bio 101" }
- show_all:            { "action": "show_all" }
- delete_class:        { "action": "delete_class", "classKey": "bio 101" }
- sync_canvas:         { "action": "sync_canvas" }
- connect_canvas:      { "action": "connect_canvas" }
- update_syllabus:     { "action": "update_syllabus", "classKey": "bio 101" }
- help:                { "action": "help" }
- reset:               { "action": "reset" }
- undo:                { "action": "undo" }
- enter_manually:      { "action": "enter_manually", "classKey": "data structures" }
- show_gpa:            { "action": "show_gpa" }
- set_credits:         { "action": "set_credits", "classKey": "bio 101", "credits": 3 }
- hypothetical_grade:  { "action": "hypothetical_grade", "classKey": "bio 101", "categoryName": "final", "score": 80 }
- delete_grade:        { "action": "delete_grade", "classKey": "bio 101", "categoryName": "midterm", "score": 45 }
- confirm:             { "action": "confirm", "guess": "Did you mean to set the class average for Bio 101 midterm to 71?", "confirmedIntent": { "action": "enter_class_average", "classKey": "bio 101", "categoryName": "midterm", "average": 71 } }
- unknown:             { "action": "unknown" }

Rules:
- Match class and category names fuzzily: "bio" matches "bio 101", "midterm" matches "Midterm Exam"
- If no class matches, set classKey to null
- Return ONLY valid JSON, no markdown, no explanation
- Any phrasing of class average → enter_class_average: "class average is X", "avg was X", "class avg: X", "the average for Y is X", "mean is X", "average: X"
- Any phrasing of a personal score → enter_grade: "got X", "scored X", "X on the Y", "made X", "I got X", "X% on"
- Any phrasing of grade inquiry → check_grade: "what's my grade", "how am I doing", "my grade", "show grade", "grade check", "where am I"
- "sync canvas", "update grades", "refresh from canvas" → sync_canvas
- "connect canvas", "setup canvas", "reconnect canvas", "login" → connect_canvas
- "update syllabus", "new weights", "syllabus changed", "update grading" → update_syllabus
- When the message is recognizable but phrased unusually, use action "confirm" with your best guess as confirmedIntent and a natural yes/no question as "guess"
- "reset", "clear everything", "start over", "delete everything" → reset
- "undo", "go back", "wait", "nevermind", "oops", "back", "undo that", "reverse that" → undo
- "enter manually", "manual", "add manually", "enter grades manually", "add grades manually" → enter_manually
- "what's my GPA", "show GPA", "calculate GPA", "my GPA", "semester GPA" → show_gpa
- "bio is 3 credits", "set bio to 4 credits", "bio 101 is 3 credit hours", "[class] = N credits" → set_credits
- "what would my grade be if I got 80 on the final", "if I score 90 on midterm what's my grade", "hypothetically if I get 75 on the final" → hypothetical_grade
- "remove my 45 on bio midterm", "delete last bio midterm grade", "erase my 72 on the final" → delete_grade; score is optional — omit if not specified
- Only use action "unknown" when you genuinely cannot determine any intent (e.g. gibberish or completely off-topic)`;

  const raw = await askClaude(system, message);

  try {
    // Try array first (Claude returns one when the message contains multiple intents)
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      const intents = JSON.parse(arrayMatch[0]);
      if (Array.isArray(intents) && intents.length > 0) {
        return intents.length === 1 ? intents[0] : { action: 'multi', intents };
      }
    }
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
  } catch (e) {
    console.error('classifyIntent: failed to parse JSON from:', raw);
  }

  return { action: 'unknown' };
}

/**
 * Match a batch of Canvas assignments to syllabus grading categories.
 * Uses a single Claude call so syncing 30 assignments costs one API call, not 30.
 *
 * @param {Array<{name: string, groupName: string}>} assignments
 * @param {Array<{name: string, weight: number}>} categories  - from the syllabus
 * @returns {object} Map of assignmentName → { catKey: string|null, confident: boolean }
 *   catKey is the exact lowercase category name (matches the grades object key in storage).
 *   confident: true if Claude is sure; false if ambiguous — bot will ask the user.
 */
export async function batchMatchAssignments(assignments, categories) {
  if (assignments.length === 0) return {};

  // ── Offline mock for TEST_MODE ────────────────────────────────────────────
  if (process.env.TEST_MODE === 'true') {
    // Simple word-overlap matching: if assignment name contains a category word, match it
    const result = {};
    for (const a of assignments) {
      const aLower = (a.name + ' ' + a.groupName).toLowerCase();
      let best = null;
      for (const cat of categories) {
        const words = cat.name.toLowerCase().split(/\s+/);
        if (words.some(w => w.length > 3 && aLower.includes(w))) {
          best = cat.name.toLowerCase();
          break;
        }
      }
      result[a.name] = best
        ? { catKey: best, confident: true }
        : { catKey: null, confident: false };
    }
    return result;
  }
  // ── Real Claude call ──────────────────────────────────────────────────────
  // Show Claude the exact keys it must use to avoid hallucinated names
  const catList = categories
    .map(c => `  • name="${c.name}"  key="${c.name.toLowerCase()}"  weight=${c.weight}%`)
    .join('\n');

  const asgList = assignments
    .map((a, i) => `  ${i + 1}. "${a.name}"  [Canvas group: "${a.groupName}"]`)
    .join('\n');

  const system = `You are matching Canvas assignments to syllabus grading categories.

Syllabus categories (use the exact key value in your response):
${catList}

Rules:
- "catKey" MUST be the exact key shown above (the lowercase version of the name)
- Use the Canvas group name as a strong hint (e.g. "Exams" group → probably "midterm exam" or "final exam")
- Use the assignment name as a secondary hint (e.g. "HW 3" → "homework")
- Set confident: true only when you are >85% sure
- If ambiguous or no category fits, set catKey: null and confident: false

Return ONLY valid JSON (no markdown):
{
  "Assignment Name": { "catKey": "exact lowercase key", "confident": true },
  "Another Name":    { "catKey": null, "confident": false }
}`;

  const raw = await askClaude(system, `Match these Canvas assignments:\n${asgList}`);

  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('batchMatchAssignments: failed to parse JSON:', raw);
  }

  // Fallback: mark everything as unconfident so the bot asks the user
  return Object.fromEntries(assignments.map(a => [a.name, { catKey: null, confident: false }]));
}

// ─── TEST_MODE mock for classifyIntent ────────────────────────────────────────
// Regex-based intent parser used when TEST_MODE=true.
// Covers all patterns used in test.js without calling the API.

function mockClassifyIntent(message, classes) {
  const t = message.trim();
  const lower = t.toLowerCase();
  const classKeys = Object.keys(classes);

  // Helper: find the first class key whose name appears in the message
  function matchClass(str) {
    return classKeys.find(k => {
      const words = k.split(' ');
      return words.some(w => str.includes(w));
    }) || null;
  }

  // new class: [name]
  let m = t.match(/^new\s+class\s*[:\-]\s*(.+)/i);
  if (m) return { action: 'new_class', className: m[1].trim() };

  // got [score] on [class?] [category]
  m = lower.match(/^got\s+(\d+(?:\.\d+)?)\s+on\s+(.+)/);
  if (m) {
    const score = Number(m[1]);
    const rest = m[2];
    const classKey = matchClass(rest);
    // category = last word(s) after the class name
    const catPart = classKey ? rest.replace(classKey.split(' ')[0], '').trim() : rest;
    return { action: 'enter_grade', classKey, categoryName: catPart.trim(), score };
  }

  // class average was [score] on [class?] [category]
  m = lower.match(/class average was\s+(\d+(?:\.\d+)?)\s+on\s+(.+)/);
  if (m) {
    const average = Number(m[1]);
    const rest = m[2];
    const classKey = matchClass(rest);
    const catPart = classKey ? rest.replace(classKey.split(' ')[0], '').trim() : rest;
    return { action: 'enter_class_average', classKey, categoryName: catPart.trim(), average };
  }

  // what's my grade in [class] / how am i doing in [class]
  m = lower.match(/(?:grade|doing)\s+in\s+(.+?)[\?]?$/);
  if (m) return { action: 'check_grade', classKey: matchClass(m[1]) };

  // show all
  if (/show all|all.*grades|all.*classes/.test(lower)) return { action: 'show_all' };

  // update syllabus for [class]
  m = lower.match(/update syllabus(?:\s+for)?\s+(.+)/);
  if (m) return { action: 'update_syllabus', classKey: matchClass(m[1]) };

  // sync / connect canvas
  if (/sync canvas|update grades/.test(lower)) return { action: 'sync_canvas' };
  if (/connect canvas|setup canvas|login/.test(lower)) return { action: 'connect_canvas' };

  // delete [class]
  m = lower.match(/^delete\s+(.+)/);
  if (m) return { action: 'delete_class', classKey: matchClass(m[1]) };

  if (/^help$/.test(lower)) return { action: 'help' };
  if (/^reset$/.test(lower)) return { action: 'reset' };
  if (/^(undo|go back|nevermind|oops|back)$/.test(lower)) return { action: 'undo' };
  if (/manual|enter manually|add manually/.test(lower)) return { action: 'enter_manually', classKey: matchClass(lower) };

  return { action: 'unknown' };
}
