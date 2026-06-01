// storage.js — Read and write all data to classes.json, and write to .env
//
// Data shape in classes.json:
// {
//   "classes": {
//     "bio 101": {
//       "name": "Bio 101",
//       "categories": [ { "name": "Midterm", "weight": 30 } ],
//       "grades": { "midterm": [85, 88] },
//       "classAverages": { "midterm": 71 },
//       "curve": { "type": "mean", "targetMean": 75 },
//       "canvasSynced": false          // true if imported from Canvas
//     }
//   },
//   "userStates": {
//     "+12025551234": { "step": "idle", "pendingClass": null }
//   },
//   "config": {
//     "canvasSetupAsked": false,       // whether we've shown the Canvas onboarding prompt
//     "canvasConnected": false
//   }
// }

import { readFileSync, writeFileSync, existsSync } from 'fs';

const DATA_FILE = './classes.json';
const ENV_FILE = './.env';

const DEFAULT = { classes: {}, userStates: {}, config: {} };

function load() {
  if (!existsSync(DATA_FILE)) return structuredClone(DEFAULT);
  try {
    return JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return structuredClone(DEFAULT);
  }
}

function save(data) {
  writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ---- Config (top-level settings) ----

export function getConfig() {
  const data = load();
  // Defaults for any missing fields
  return {
    canvasSetupAsked: false,
    canvasConnected: false,
    ...(data.config || {}),
  };
}

export function saveConfig(config) {
  const data = load();
  data.config = config;
  save(data);
}

// ---- User state ----

export function getUserState(phone) {
  return load().userStates[phone] || { step: 'idle', pendingClass: null };
}

export function setUserState(phone, state) {
  const data = load();
  data.userStates[phone] = state;
  save(data);
}

// Write pendingConfirmation without touching step/pendingClass.
// Use this whenever the bot asks a choice question — it's a guaranteed
// atomic write that cannot be silently overwritten by a setUserState
// call that doesn't carry the pendingConfirmation field forward.
export function setPendingConfirmation(phone, confirmation) {
  const data = load();
  const existing = data.userStates[phone] || { step: 'idle', pendingClass: null };
  existing.pendingConfirmation = confirmation;
  data.userStates[phone] = existing;
  save(data);
}

export function clearPendingConfirmation(phone) {
  const data = load();
  const existing = data.userStates[phone] || { step: 'idle', pendingClass: null };
  delete existing.pendingConfirmation;
  data.userStates[phone] = existing;
  save(data);
}

// ---- Classes ----

export function getAllClasses() {
  return load().classes;
}

export function getClass(key) {
  return load().classes[key] || null;
}

export function saveClass(key, classData) {
  const data = load();
  data.classes[key] = classData;
  save(data);
}

export function deleteClass(key) {
  const data = load();
  delete data.classes[key];
  save(data);
}

// ---- Last action (for undo) ----

export function saveLastAction(action) {
  const data = load();
  data.lastAction = { ...action, timestamp: new Date().toISOString() };
  save(data);
}

export function getLastAction() {
  return load().lastAction || null;
}

export function clearLastAction() {
  const data = load();
  delete data.lastAction;
  save(data);
}

export function resetClasses() {
  const data = load();
  data.classes = {};
  data.userStates = {};
  save(data);
}

export function resetAll() {
  save(structuredClone(DEFAULT));
}

// ---- .env writer ----------------------------------------------------------------
//
// Writes a key=value line to the .env file so Canvas credentials persist
// across server restarts. Also sets process.env[key] immediately so the
// running server can use the value without restarting.

export function setEnvVar(key, value) {
  let content = '';

  if (existsSync(ENV_FILE)) {
    content = readFileSync(ENV_FILE, 'utf8');
    const lineRegex = new RegExp(`^${key}=.*$`, 'm');
    if (lineRegex.test(content)) {
      // Replace the existing line
      content = content.replace(lineRegex, `${key}=${value}`);
    } else {
      // Append a new line
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  } else {
    content = `${key}=${value}\n`;
  }

  writeFileSync(ENV_FILE, content);
  process.env[key] = value; // available immediately without restart
}
