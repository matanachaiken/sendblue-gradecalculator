// src/migrate-to-sqlite.ts
// Run once: node dist/migrate-to-sqlite.js
// Reads classes.json and imports all data into SQLite.
import dotenv from 'dotenv';
dotenv.config({ override: true });

import { existsSync, readFileSync } from 'fs';
import type { StorageData } from './types.js';

const DATA_FILE = './classes.json';
const phone = process.env.MY_PHONE;

if (!phone) {
  console.error('MY_PHONE not set in .env');
  process.exit(1);
}

if (!existsSync(DATA_FILE)) {
  console.log('No classes.json found — nothing to migrate.');
  process.exit(0);
}

// Dynamic import so DB_PATH env is set before db.ts initialises
const { setUserState, saveClass, saveConfig, saveLastAction } = await import('./storage.js');

let raw: StorageData;
try {
  raw = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as StorageData;
} catch (e) {
  console.error('Failed to parse classes.json:', (e as Error).message);
  process.exit(1);
}

let migrated = 0;

// Migrate user states
if (raw.userStates) {
  for (const [userPhone, state] of Object.entries(raw.userStates)) {
    setUserState(userPhone, state);
    console.log(`  ✓ user state for ${userPhone}`);
    migrated++;
  }
} else {
  // Single-user mode: ensure MY_PHONE row exists with default state
  setUserState(phone, { step: 'idle', pendingClass: null });
}

// Migrate classes
if (raw.classes) {
  for (const [key, classData] of Object.entries(raw.classes)) {
    saveClass(phone, key, classData);
    console.log(`  ✓ class: ${key}`);
    migrated++;
  }
}

// Migrate config
if (raw.config) {
  saveConfig(phone, raw.config);
  console.log('  ✓ config');
  migrated++;
}

// Migrate lastAction
if (raw.lastAction) {
  // lastAction already has timestamp in the JSON
  // saveLastAction adds its own timestamp, so we use it directly
  const { timestamp: _ts, ...actionWithoutTimestamp } = raw.lastAction as { timestamp: string } & Record<string, unknown>;
  // Cast: saveLastAction expects DistributiveOmit<LastAction, 'timestamp'>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  saveLastAction(phone, actionWithoutTimestamp as any);
  console.log('  ✓ lastAction');
  migrated++;
}

console.log(`\nMigration complete. ${migrated} items migrated from ${DATA_FILE}.`);
console.log('You can now delete classes.json and use DB_PATH=./data/grade-brain.db.');
