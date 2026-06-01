// test.js — Scripted conversation test. No iMessages are sent.
//
// Run with:   node test.js
//
// What it tests:
//   1. New class setup (syllabus → curve → Canvas skip)
//   2. Logging grades
//   3. Checking grade with "to earn" targets
//   4. Second class with a mean curve + class average
//   5. "Show all my grades"
//   6. Syllabus update mid-semester (weights change, grades preserved)
//   7. Help command

// Must be set before any imports so sendblue.js picks it up
process.env.TEST_MODE = 'true';

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';

// Dynamic import so TEST_MODE is already set when bot.js loads
const { handleIncomingMessage } = await import('./bot.js');

const DATA_FILE = './classes.json';
const FROM = process.env.MY_PHONE;

// ── Backup any real data so we don't wipe it ──────────────────────────────────
const backup = existsSync(DATA_FILE) ? readFileSync(DATA_FILE, 'utf8') : null;
if (existsSync(DATA_FILE)) unlinkSync(DATA_FILE);

// ── Helper: print what the user "sends", then run it through the bot ──────────
async function say(msg, label = '') {
  const tag = label ? ` (${label})` : '';
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`You${tag}: ${msg}`);
  await handleIncomingMessage(FROM, msg, null);
}

console.log('═'.repeat(55));
console.log('  grade-brain local test  (no texts sent)');
console.log('═'.repeat(55));

// ── 1. New class: Bio 101, no curve, no Canvas ────────────────────────────────
await say('new class: Bio 101');
await say('Midterm 30%, Final 40%, Homework 20%, Participation 10%', 'syllabus');
await say('4', 'no curve');
await say('no', 'skip Canvas');

// ── 2. Log some grades ────────────────────────────────────────────────────────
await say('got 85 on bio midterm');
await say('got 90 on bio homework');
await say('got 78 on bio homework');
await say('got 95 on bio participation');

// ── 3. Check grade ────────────────────────────────────────────────────────────
await say("what's my grade in bio?");

// ── 4. Second class with mean curve ──────────────────────────────────────────
await say('new class: Chem 201');
await say('Midterm 25%, Final 35%, Labs 25%, Quizzes 15%', 'syllabus');
await say('2', 'mean curve');
await say('75', 'target mean = 75');
await say('no', 'skip Canvas');

await say('got 80 on chem midterm');
await say('class average was 68 on chem 201 midterm');
await say("what's my grade in chem?", 'should show curved score');

// ── 5. Show all ───────────────────────────────────────────────────────────────
await say('show all my grades');

// ── 6. Syllabus update — weights change, grades must survive ──────────────────
await say('update syllabus for bio');
await say('Midterm 25%, Final 45%, Homework 20%, Participation 10%', 'new weights');
await say("what's my grade in bio?", 'grades should still be there with new weights');

// ── 7. Help ───────────────────────────────────────────────────────────────────
await say('help');

// ── Restore original data ─────────────────────────────────────────────────────
if (backup) {
  writeFileSync(DATA_FILE, backup);
  console.log('\n[Restored your original classes.json]');
} else if (existsSync(DATA_FILE)) {
  unlinkSync(DATA_FILE);
  console.log('\n[Cleaned up test classes.json]');
}

console.log('\n' + '═'.repeat(55));
console.log('  Done.');
console.log('═'.repeat(55));
