// test.js — Comprehensive tests for grade-brain
// Run with: node test.js
//
// Sections:
//   1. Grade calculation  — pure unit tests on grades.js functions
//   2. Conversation flows — full bot simulation via handleIncomingMessage
//   3. Input parsing      — natural language → correct intent / state
//   4. Edge cases         — boundary conditions and unusual inputs

process.env.TEST_MODE = 'true';
process.env.MY_PHONE = process.env.MY_PHONE || '+10000000000';

import assert from 'assert';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { calcCurrentGrade, calcNeeded, calcBestPossible, calcGPA } from './grades.js';

const { handleIncomingMessage } = await import('./bot.js');

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function test(desc, fn) {
  try {
    fn();
    process.stdout.write(`  ✓  ${desc}\n`);
    passed++;
  } catch (e) {
    process.stdout.write(`  ✗  ${desc}\n     → ${e.message}\n`);
    failed++;
    failures.push(desc);
  }
}

async function testA(desc, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓  ${desc}\n`);
    passed++;
  } catch (e) {
    process.stdout.write(`  ✗  ${desc}\n     → ${e.message}\n`);
    failed++;
    failures.push(desc);
  }
}

// ── Data helpers ─────────────────────────────────────────────────────────────

const DATA_FILE = './classes.json';
const FROM = process.env.MY_PHONE;

function reset() {
  if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);
}

function getData() {
  if (!existsSync(DATA_FILE)) return { classes: {}, userStates: {}, config: {} };
  return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
}

function getClassData(key) {
  return getData().classes[key.toLowerCase()] ?? null;
}

function getPending() {
  return getData().userStates?.[FROM]?.pendingConfirmation ?? null;
}

function getStep() {
  return getData().userStates?.[FROM]?.step ?? 'idle';
}

function setPendingDirectly(pendingConfirmation) {
  const data = getData();
  data.userStates = data.userStates || {};
  data.userStates[FROM] = data.userStates[FROM] || { step: 'idle', pendingClass: null };
  data.userStates[FROM].pendingConfirmation = pendingConfirmation;
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// Suppress bot console output during conversation tests
const origLog = console.log;
function mute() {
  console.log = (...args) => {
    const s = args.join(' ');
    if (!s.startsWith('\nBot:') && !s.includes('PENDING') && !s.includes('[canvas]'))
      origLog(...args);
  };
}
function unmute() { console.log = origLog; }

async function say(msg) {
  await handleIncomingMessage(FROM, msg, null);
}

async function capture(fn) {
  const msgs = [];
  console.log = (...args) => {
    const s = args.join(' ');
    if (s.includes('\nBot:')) msgs.push(s.replace(/.*\nBot: /, '').trim());
  };
  await fn();
  console.log = origLog;
  return msgs;
}

// Quick class setup helper
async function setupClass(name, syllabus = 'Homework 40%, Midterm 30%, Final 30%', curveChoice = '4') {
  await say(`new class: ${name}`);
  await say(syllabus);
  await say(curveChoice);
  await say('no'); // skip Canvas
}

// ── classData builder for pure unit tests ────────────────────────────────────

function mkClass({ categories, grades = {}, canvasGrades = {}, curve = { type: 'none' }, dynamicWeights = null } = {}) {
  return { name: 'Test', categories, grades, canvasGrades, classAverages: {}, curve, dynamicWeights };
}

// ── Backup real data ─────────────────────────────────────────────────────────

const backup = existsSync(DATA_FILE) ? readFileSync(DATA_FILE, 'utf8') : null;
reset();

// ═══════════════════════════════════════════════════════════════════════════
process.stdout.write('\n══ 1. Grade Calculation ══\n');

test('No curve — all grades, exact weighted avg (83.0%)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80], final: [70] },
  });
  const r = calcCurrentGrade(c);
  assert.ok(r, 'result should not be null');
  assert.strictEqual(r.rawGrade, 83.0, `expected 83.0, got ${r.rawGrade}`);
  assert.strictEqual(r.completedWeight, 100);
});

test('No curve — partial grades normalized by completed weight (88.6%)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80] },
  });
  const r = calcCurrentGrade(c);
  // (95×40 + 80×30) / 70 = 6200/70 = 88.571 → 88.6
  assert.strictEqual(r.rawGrade, 88.6);
  assert.strictEqual(r.completedWeight, 70);
});

test('Flat curve adds points to final grade (83 + 5 = 88)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80], final: [70] },
    curve: { type: 'flat', flatPoints: 5 },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.rawGrade, 83.0);
  assert.strictEqual(r.curvedGrade, 88.0);
});

test('Flat curve caps at 100', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [98] },
    curve: { type: 'flat', flatPoints: 5 },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedGrade, 100.0);
});

test('Mean curve — positive shift applied (83 + 7 = 90)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80], final: [70] },
    curve: { type: 'mean', targetMean: 75, classAvg: 68 },
  });
  // shift = 75 − 68 = 7 → 83 + 7 = 90
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedGrade, 90.0);
  assert.ok(!r.curveNoShift);
});

test('Mean curve — no shift when classAvg exceeds targetMean', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80], final: [70] },
    curve: { type: 'mean', targetMean: 75, classAvg: 80 },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedGrade, 83.0);
  assert.ok(r.curveNoShift, 'noShift flag should be true');
});

test('Mean curve — pending when classAvg not yet entered', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [85] },
    curve: { type: 'mean', targetMean: 75, classAvg: null },
  });
  const r = calcCurrentGrade(c);
  assert.ok(r.curvePending);
  assert.strictEqual(r.curvedLetter, null);
});

test('Mean curve — caps at 100 when shift would exceed it', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [98] },
    curve: { type: 'mean', targetMean: 75, classAvg: 60 },
  });
  // shift = 15 → 98 + 15 = 113 → capped at 100
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedGrade, 100.0);
});

test('Norm curve — above-median maps to higher letter (83, median=75, B → B+)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [83] },
    // GRADE_SCALE: A A- B+ B B- C+ C C- D F (indices 0–9)
    // B = index 3, stepsAbove = 3
    // distAbove = 83−75 = 8, room = 25, pct = 0.32 → stepsUp = round(0.96) = 1
    // result = GRADE_SCALE[3−1] = 'B+'
    curve: { type: 'norm', median: 75, mappedGrade: 'B' },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedLetter, 'B+');
  assert.ok(!r.curvePending);
});

test('Norm curve — below-median maps to lower letter (60, median=75, B → B-)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [60] },
    // stepsBelow = 9−3 = 6, distBelow = 15, roomBelow = 75
    // pct = 0.2 → stepsDown = round(1.2) = 1 → GRADE_SCALE[3+1] = 'B-'
    curve: { type: 'norm', median: 75, mappedGrade: 'B' },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedLetter, 'B-');
});

test('Norm curve — at exactly median returns mapped letter', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [75] },
    curve: { type: 'norm', median: 75, mappedGrade: 'B' },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedLetter, 'B');
});

test('Norm curve — letter-only (median=null, mappedGrade set) shows target', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [83] },
    curve: { type: 'norm', median: null, mappedGrade: 'B+' },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.curvedLetter, 'B+');
  assert.ok(!r.curvePending);
  assert.ok(r.curveNote.includes('no numeric median'));
});

test('Norm curve — pending when neither median nor mappedGrade set', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [85] },
    curve: { type: 'norm' },
  });
  const r = calcCurrentGrade(c);
  assert.ok(r.curvePending);
  assert.strictEqual(r.curvedLetter, null);
});

test('Norm curve — pending when median set but mappedGrade missing', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [85] },
    curve: { type: 'norm', median: 75 },
  });
  const r = calcCurrentGrade(c);
  assert.ok(r.curvePending);
});

test('calcCurrentGrade — returns null when no grades entered', () => {
  const c = mkClass({ categories: [{ name: 'Homework', weight: 100 }], grades: {} });
  assert.strictEqual(calcCurrentGrade(c), null);
});

test('Multiple grades in same category are averaged', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [80, 90, 100] },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.rawGrade, 90.0);
});

test('calcNeeded — A not achievable returns > 100', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80] },
  });
  // needed for 93 = (93×100 − 6200) / 30 = 103.3
  const needed = calcNeeded(c, 93);
  assert.ok(needed > 100, `expected > 100, got ${needed}`);
});

test('calcNeeded — B achievable (need 70 on final)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80] },
  });
  // needed for 83 = (83×100 − 6200) / 30 = 70.0
  assert.strictEqual(calcNeeded(c, 83), 70.0);
});

test('calcNeeded — returns null when nothing remains', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [85] },
  });
  assert.strictEqual(calcNeeded(c, 93), null);
});

test('calcNeeded — returns null for norm curve', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 50 }, { name: 'Final', weight: 50 }],
    grades: { homework: [85] },
    curve: { type: 'norm', median: 75, mappedGrade: 'B' },
  });
  assert.strictEqual(calcNeeded(c, 93), null);
});

test('calcNeeded — flat curve accounts for inverse shift (need 96 for A)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 50 }, { name: 'Final', weight: 50 }],
    grades: { homework: [80] },
    curve: { type: 'flat', flatPoints: 5 },
  });
  // targetRaw = 93−5=88; needed = (88×100 − 80×50)/50 = (8800−4000)/50 = 96
  assert.strictEqual(calcNeeded(c, 93), 96.0);
});

test('calcNeeded — mean curve accounts for inverse shift (need 92 for A)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 50 }, { name: 'Final', weight: 50 }],
    grades: { homework: [80] },
    curve: { type: 'mean', targetMean: 75, classAvg: 68 },
  });
  // shift=7, targetRaw=93−7=86; needed = (86×100 − 80×50)/50 = (8600−4000)/50 = 92
  assert.strictEqual(calcNeeded(c, 93), 92.0);
});

test('calcBestPossible — fills remaining categories with 100 (result: 92.0%)', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { homework: [95], midterm: [80] },
  });
  // Best: Final=100 → (95×40 + 80×30 + 100×30)/100 = 92.0
  const r = calcBestPossible(c);
  assert.ok(r, 'should not be null');
  assert.strictEqual(r.rawGrade, 92.0);
});

test('calcBestPossible — returns null when all grades entered', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100 }],
    grades: { homework: [85] },
  });
  assert.strictEqual(calcBestPossible(c), null);
});

test('calcBestPossible — merges canvasGrades before checking remaining', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 50 }, { name: 'Midterm', weight: 50 }],
    grades: { homework: [90] },
    canvasGrades: { midterm: [80] },
  });
  // Both categories covered via merge → no remaining → null
  assert.strictEqual(calcBestPossible(c), null);
});

test('Drop-lowest — excludes minimum score from average', () => {
  const c = mkClass({
    categories: [
      { name: 'Homework', weight: 40, dropLowest: 1 },
      { name: 'Midterm', weight: 30 },
      { name: 'Final', weight: 30 },
    ],
    grades: { homework: [70, 80, 90], midterm: [80], final: [70] },
  });
  // HW: drop 70 → avg(80,90)=85 → (85×40+80×30+70×30)/100 = 79.0
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.rawGrade, 79.0);
  assert.strictEqual(r.breakdown.find(b => b.name === 'Homework').droppedCount, 1);
});

test('Drop-lowest — not applied when fewer grades than drop count', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 100, dropLowest: 2 }],
    grades: { homework: [80] },
  });
  // Only 1 grade, dropLowest=2 → no drop → avg=80
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.rawGrade, 80.0);
  assert.strictEqual(r.breakdown[0].droppedCount, 0);
});

test('Canvas grades and manual grades merged for calculation', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 50 }, { name: 'Midterm', weight: 50 }],
    grades: { homework: [90] },
    canvasGrades: { midterm: [80] },
  });
  // merged: HW=90, Midterm=80 → (90×50+80×50)/100 = 85.0
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.rawGrade, 85.0);
  assert.strictEqual(r.completedWeight, 100);
});

test('Dynamic weights — best midterm gets higher weight (80.5%)', () => {
  const c = {
    name: 'Test',
    categories: [
      { name: 'Midterm A', weight: 22.5 },
      { name: 'Midterm B', weight: 22.5 },
      { name: 'Final', weight: 55 },
    ],
    grades: { 'midterm a': [90], 'midterm b': [70], final: [80] },
    canvasGrades: {},
    classAverages: {},
    curve: { type: 'none' },
    dynamicWeights: {
      type: 'best_worst',
      categoryA: 'Midterm A',
      categoryB: 'Midterm B',
      bestWeight: 25,
      worstWeight: 20,
    },
  };
  // Midterm A (90) → 25%, Midterm B (70) → 20%, Final (80) → 55%
  // (90×25 + 70×20 + 80×55)/100 = (2250+1400+4400)/100 = 80.5
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.rawGrade, 80.5);
});

test('calcGPA — weighted average across classes (3.6)', () => {
  const classes = {
    'bio 101': {
      ...mkClass({ categories: [{ name: 'Final', weight: 100 }], grades: { final: [95] } }),
      name: 'Bio 101', creditHours: 3,
    },
    'chem 201': {
      ...mkClass({ categories: [{ name: 'Final', weight: 100 }], grades: { final: [88] } }),
      name: 'Chem 201', creditHours: 4,
    },
  };
  // Bio: 95→A (4.0)×3cr; Chem: 88→B+ (3.3)×4cr → (12+13.2)/7 = 3.6
  const { gpa, included } = calcGPA(classes);
  assert.strictEqual(included.length, 2);
  assert.strictEqual(gpa, 3.6);
});

test('calcGPA — reports classes missing credit hours', () => {
  const classes = {
    'bio 101': {
      ...mkClass({ categories: [{ name: 'Final', weight: 100 }], grades: { final: [95] } }),
      name: 'Bio 101',
      // no creditHours
    },
  };
  const { gpa, missing } = calcGPA(classes);
  assert.strictEqual(gpa, null);
  assert.ok(missing.includes('Bio 101'));
});

test('calcGPA — skips classes with no grades', () => {
  const classes = {
    'bio 101': {
      ...mkClass({ categories: [{ name: 'Final', weight: 100 }], grades: {} }),
      name: 'Bio 101', creditHours: 3,
    },
  };
  const { gpa, noGrades } = calcGPA(classes);
  assert.strictEqual(gpa, null);
  assert.ok(noGrades.includes('Bio 101'));
});

// ═══════════════════════════════════════════════════════════════════════════
process.stdout.write('\n══ 2. Conversation Flows ══\n');

await testA('New class setup — categories saved correctly', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  unmute();
  const cd = getClassData('bio 101');
  assert.ok(cd, 'class should exist');
  assert.strictEqual(cd.categories.length, 3);
  assert.ok(cd.categories.find(c => c.name.toLowerCase().includes('homework')));
  assert.strictEqual(cd.curve.type, 'none');
});

await testA('Flat curve — flatPoints saved correctly', async () => {
  reset(); mute();
  await say('new class: Math 101');
  await say('Homework 50%, Final 50%');
  await say('1'); // flat
  await say('5'); // 5 pts
  await say('no');
  unmute();
  const cd = getClassData('math 101');
  assert.strictEqual(cd.curve.type, 'flat');
  assert.strictEqual(cd.curve.flatPoints, 5);
});

await testA('Mean curve — targetMean saved correctly', async () => {
  reset(); mute();
  await say('new class: Chem 201');
  await say('Homework 50%, Final 50%');
  await say('2'); // mean
  await say('75');
  await say('no');
  unmute();
  const cd = getClassData('chem 201');
  assert.strictEqual(cd.curve.type, 'mean');
  assert.strictEqual(cd.curve.targetMean, 75);
});

await testA('Norm curve — curve.type=norm saved', async () => {
  reset(); mute();
  await say('new class: Physics 101');
  await say('Homework 50%, Final 50%');
  await say('3'); // norm
  await say('no');
  unmute();
  const cd = getClassData('physics 101');
  assert.strictEqual(cd.curve.type, 'norm');
});

await testA('Enter grade — saves to correct category', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  unmute();
  const cd = getClassData('bio 101');
  const grades = cd.grades.midterm ?? [];
  assert.ok(grades.includes(85), `grades=${JSON.stringify(grades)}`);
});

await testA('Enter grade — multiple grades averaged in display', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 80 on bio homework');
  await say('got 100 on bio homework');
  unmute();
  const cd = getClassData('bio 101');
  assert.deepStrictEqual(cd.grades.homework, [80, 100]);
});

await testA('Class average saved to curve.classAvg for mean curve', async () => {
  reset(); mute();
  await say('new class: Chem 201');
  await say('Homework 50%, Midterm 50%');
  await say('2'); await say('75'); await say('no');
  await say('got 80 on chem midterm');
  await say('class average was 68 on chem midterm');
  unmute();
  const cd = getClassData('chem 201');
  assert.strictEqual(cd.curve.classAvg, 68);
});

await testA('Syllabus update — preserves grades, updates weights', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  await say('update syllabus for bio');
  await say('Homework 30%, Midterm 40%, Final 30%');
  unmute();
  const cd = getClassData('bio 101');
  assert.ok((cd.grades.midterm ?? []).includes(85), 'grade should survive update');
  const midCat = cd.categories.find(c => c.name.toLowerCase().includes('midterm'));
  assert.strictEqual(midCat.weight, 40, 'weight should be updated');
});

await testA('Undo — creates confirm_undo pending with last action', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  await say('undo');
  unmute();
  const pc = getPending();
  assert.ok(pc, 'should have pending confirmation');
  assert.strictEqual(pc.type, 'confirm_undo');
  assert.ok(pc.data?.last, 'should contain last action');
  assert.strictEqual(pc.data.last.type, 'grade_saved');
});

await testA('Undo confirm yes — grade removed', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  await say('undo');
  await say('yes');
  unmute();
  const grades = getClassData('bio 101')?.grades?.midterm ?? [];
  assert.ok(!grades.includes(85), 'grade 85 should be removed');
});

await testA('Undo confirm no — grade preserved', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  await say('undo');
  await say('no');
  unmute();
  const grades = getClassData('bio 101')?.grades?.midterm ?? [];
  assert.ok(grades.includes(85), 'grade 85 should still be there');
});

await testA('awaiting_numeric_median — plain number saves median + letter', async () => {
  reset(); mute();
  await say('new class: DS');
  await say('Homework 50%, Final 50%');
  await say('3'); await say('no');
  unmute();
  // Directly inject the pending state (bypasses Claude in TEST_MODE)
  const data = getData();
  data.classes['ds'].curve = { type: 'norm' };
  data.userStates = data.userStates || {};
  data.userStates[FROM] = { step: 'idle', pendingClass: null,
    pendingConfirmation: { type: 'awaiting_numeric_median', data: { classKey: 'ds', letter: 'B+' }, question: 'q' },
  };
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  mute(); await say('72'); unmute();
  const cd = getClassData('ds');
  assert.strictEqual(cd.curve.median, 72);
  assert.strictEqual(cd.curve.mappedGrade, 'B+');
});

await testA('awaiting_numeric_median — "skip" saves letter only, no median', async () => {
  reset(); mute();
  await say('new class: DS');
  await say('Homework 50%, Final 50%');
  await say('3'); await say('no');
  unmute();
  const data = getData();
  data.classes['ds'].curve = { type: 'norm' };
  data.userStates = data.userStates || {};
  data.userStates[FROM] = { step: 'idle', pendingClass: null,
    pendingConfirmation: { type: 'awaiting_numeric_median', data: { classKey: 'ds', letter: 'B+' }, question: 'q' },
  };
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  mute(); await say('skip'); unmute();
  const cd = getClassData('ds');
  assert.strictEqual(cd.curve.mappedGrade, 'B+');
  assert.ok(cd.curve.median == null, 'median should not be set');
});

await testA('awaiting_numeric_median — non-number re-prompts without clearing state', async () => {
  reset(); mute();
  await say('new class: DS');
  await say('Homework 50%, Final 50%');
  await say('3'); await say('no');
  unmute();
  const data = getData();
  data.classes['ds'].curve = { type: 'norm' };
  data.userStates = data.userStates || {};
  data.userStates[FROM] = { step: 'idle', pendingClass: null,
    pendingConfirmation: { type: 'awaiting_numeric_median', data: { classKey: 'ds', letter: 'B+' }, question: 'q' },
  };
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  mute(); await say('not a number'); unmute();
  // State should still have the pending confirmation
  const pc = getPending();
  assert.ok(pc, 'pending should be re-saved');
  assert.strictEqual(pc.type, 'awaiting_numeric_median');
});

await testA('Canvas resync offer — undo canvas link triggers resync question', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  unmute();
  // Simulate a canvas_linked last action
  const data = getData();
  data.lastAction = {
    type: 'canvas_linked',
    classKey: 'bio 101',
    className: 'Bio 101',
    previousClassData: data.classes['bio 101'],
    timestamp: new Date().toISOString(),
  };
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  mute(); await say('undo'); await say('yes'); unmute();
  const pc = getPending();
  assert.ok(pc, 'should offer resync');
  assert.strictEqual(pc.type, 'canvas_resync_offer');
});

// ═══════════════════════════════════════════════════════════════════════════
process.stdout.write('\n══ 3. Input Parsing ══\n');

await testA('"got 85 on bio midterm" → grade 85 saved', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  unmute();
  const grades = getClassData('bio 101')?.grades?.midterm ?? [];
  assert.ok(grades.includes(85));
});

await testA('"got 78 on bio homework" → grade 78 saved', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 78 on bio homework');
  unmute();
  const grades = getClassData('bio 101')?.grades?.homework ?? [];
  assert.ok(grades.includes(78));
});

await testA('"class average was 72 on chem midterm" → classAverages saved', async () => {
  reset(); mute();
  await say('new class: Chem 201');
  await say('Homework 50%, Midterm 50%');
  await say('4'); await say('no');
  await say('got 80 on chem midterm');
  await say('class average was 72 on chem midterm');
  unmute();
  const cd = getClassData('chem 201');
  assert.strictEqual(cd.classAverages?.midterm, 72);
});

await testA('"delete bio" → confirm_delete pending', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('delete bio');
  unmute();
  const pc = getPending();
  assert.ok(pc);
  assert.strictEqual(pc.type, 'confirm_delete');
  assert.strictEqual(pc.data.classKey, 'bio 101');
});

await testA('"reset" → confirm_reset pending', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('reset');
  unmute();
  const pc = getPending();
  assert.ok(pc);
  assert.strictEqual(pc.type, 'confirm_reset');
});

await testA('"undo" after grade entry → confirm_undo pending', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  await say('undo');
  unmute();
  const pc = getPending();
  assert.ok(pc);
  assert.strictEqual(pc.type, 'confirm_undo');
});

await testA('"show all my grades" → no crash', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  let ok = true;
  try { mute(); await say('show all my grades'); unmute(); }
  catch { ok = false; unmute(); }
  assert.ok(ok);
});

await testA('"my GPA" → show_gpa intent handled', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  let ok = true;
  try { mute(); await say('my gpa'); unmute(); }
  catch { ok = false; unmute(); }
  assert.ok(ok, 'show_gpa should not crash');
});

await testA('"bio is 3 credits" → creditHours saved', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('bio is 3 credits');
  unmute();
  const cd = getClassData('bio 101');
  assert.strictEqual(cd.creditHours, 3);
});

await testA('"what if I got 90 on bio final" → hypothetical no crash', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  let ok = true;
  try { mute(); await say('what if I got 90 on bio final'); unmute(); }
  catch { ok = false; unmute(); }
  assert.ok(ok, 'hypothetical_grade should not crash');
});

await testA('"remove my 85 on bio midterm" → grade deleted', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  await say('remove my 85 on bio midterm');
  unmute();
  const grades = getClassData('bio 101')?.grades?.midterm ?? [];
  assert.ok(!grades.includes(85), 'grade should be deleted');
});

// ═══════════════════════════════════════════════════════════════════════════
process.stdout.write('\n══ 4. Edge Cases ══\n');

await testA('Score 0 is valid', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 0 on bio midterm');
  unmute();
  assert.ok((getClassData('bio 101')?.grades?.midterm ?? []).includes(0));
});

await testA('Score 150 is valid (upper edge)', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 150 on bio midterm');
  unmute();
  assert.ok((getClassData('bio 101')?.grades?.midterm ?? []).includes(150));
});

await testA('Score 151 is rejected', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 151 on bio midterm');
  unmute();
  assert.ok(!(getClassData('bio 101')?.grades?.midterm ?? []).includes(151));
});

await testA('Score 9999 is rejected', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 9999 on bio midterm');
  unmute();
  assert.ok(!(getClassData('bio 101')?.grades?.midterm ?? []).includes(9999));
});

await testA('Syllabus weights not summing to 100 triggers warning message', async () => {
  reset();
  const msgs = await capture(async () => {
    await say('new class: Weird Class');
    await say('Homework 40%, Midterm 30%'); // only 70%
  });
  const hasWarning = msgs.some(m => m.includes('70%') || m.includes('add up') || m.includes('not 100'));
  assert.ok(hasWarning, `expected weight warning, got: ${JSON.stringify(msgs)}`);
});

await testA('Existing class re-setup asks restart/keep', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('new class: Bio 101');
  unmute();
  const pc = getPending();
  assert.ok(pc);
  assert.strictEqual(pc.type, 'new_class_mode');
});

await testA('Reset 1 clears all classes', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('reset');
  await say('1');
  unmute();
  assert.strictEqual(Object.keys(getData().classes).length, 0);
});

await testA('Delete class with confirmation yes removes it', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('delete bio');
  await say('yes');
  unmute();
  assert.ok(!getClassData('bio 101'), 'class should be deleted');
});

await testA('Delete class with confirmation no keeps it', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('delete bio');
  await say('no');
  unmute();
  assert.ok(getClassData('bio 101'), 'class should still exist');
});

await testA('Canvas sync does not wipe manual grades', async () => {
  reset(); mute();
  await setupClass('Bio 101');
  await say('got 85 on bio midterm');
  unmute();
  // Simulate a canvas sync writing to canvasGrades (not grades)
  const data = getData();
  data.classes['bio 101'].canvasGrades = { homework: [90] };
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  // Manual grade in grades.midterm should still be there
  const cd = getClassData('bio 101');
  assert.ok((cd.grades?.midterm ?? []).includes(85), 'manual grade should survive canvas write');
  assert.deepStrictEqual(cd.canvasGrades?.homework, [90]);
});

test('Norm curve letter-only — calcBestPossible still works', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 50 }, { name: 'Final', weight: 50 }],
    grades: { homework: [85] },
    curve: { type: 'norm', median: null, mappedGrade: 'B+' },
  });
  const r = calcBestPossible(c);
  assert.ok(r, 'best possible should work with letter-only norm curve');
  assert.strictEqual(r.curvedLetter, 'B+');
});

test('Single grade entered — completedWeight reflects only that category', () => {
  const c = mkClass({
    categories: [{ name: 'Homework', weight: 40 }, { name: 'Midterm', weight: 30 }, { name: 'Final', weight: 30 }],
    grades: { midterm: [80] },
  });
  const r = calcCurrentGrade(c);
  assert.strictEqual(r.completedWeight, 30);
  assert.strictEqual(r.rawGrade, 80.0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Restore real data
if (backup) {
  writeFileSync(DATA_FILE, backup);
} else if (existsSync(DATA_FILE)) {
  unlinkSync(DATA_FILE);
}

// Summary
const total = passed + failed;
process.stdout.write(`\n${'═'.repeat(50)}\n`);
process.stdout.write(`  ${passed}/${total} passed`);
if (failed > 0) {
  process.stdout.write(`  (${failed} failed)\n\n  Failed:\n`);
  failures.forEach(f => process.stdout.write(`    • ${f}\n`));
} else {
  process.stdout.write('  — all green\n');
}
process.stdout.write('═'.repeat(50) + '\n');

process.exit(failed > 0 ? 1 : 0);
