// storage.ts — Delegates all data operations to db.ts.
// To swap the backing store (e.g. to Supabase), replace db.ts only.
// setEnvVar still writes to .env — it is not user data.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import type { ClassData, UserState, Config, LastAction, PendingConfirmation } from './types.js';
import type { DistributiveOmit } from './types.js';
import {
  dbGetUserState,
  dbSetUserState,
  dbSetPendingConfirmation,
  dbClearPendingConfirmation,
  dbGetAllClasses,
  dbGetClass,
  dbSaveClass,
  dbDeleteClass,
  dbGetConfig,
  dbSaveConfig,
  dbSaveLastAction,
  dbGetLastAction,
  dbClearLastAction,
  dbResetClasses,
  dbResetAll,
} from './db.js';

const ENV_FILE = './.env';

// ---- User state ----

export function getUserState(phone: string): UserState {
  return dbGetUserState(phone);
}

export function setUserState(phone: string, state: UserState): void {
  dbSetUserState(phone, state);
}

export function setPendingConfirmation(phone: string, pc: PendingConfirmation): void {
  dbSetPendingConfirmation(phone, pc);
}

export function clearPendingConfirmation(phone: string): void {
  dbClearPendingConfirmation(phone);
}

// ---- Classes ----

export function getAllClasses(phone: string): Record<string, ClassData> {
  return dbGetAllClasses(phone);
}

export function getClass(phone: string, key: string): ClassData | null {
  return dbGetClass(phone, key);
}

export function saveClass(phone: string, key: string, classData: ClassData): void {
  dbSaveClass(phone, key, classData);
}

export function deleteClass(phone: string, key: string): void {
  dbDeleteClass(phone, key);
}

// ---- Config ----

export function getConfig(phone: string): Config {
  return dbGetConfig(phone);
}

export function saveConfig(phone: string, config: Config): void {
  dbSaveConfig(phone, config);
}

// ---- Last action (for undo) ----

export function saveLastAction(phone: string, action: DistributiveOmit<LastAction, 'timestamp'>): void {
  dbSaveLastAction(phone, action);
}

export function getLastAction(phone: string): LastAction | null {
  return dbGetLastAction(phone);
}

export function clearLastAction(phone: string): void {
  dbClearLastAction(phone);
}

// ---- Reset ----

export function resetClasses(phone: string): void {
  dbResetClasses(phone);
}

export function resetAll(phone: string): void {
  dbResetAll(phone);
}

// ---- .env writer ----------------------------------------------------------------
//
// Writes a key=value line to the .env file so Canvas credentials persist
// across server restarts. Also sets process.env[key] immediately so the
// running server can use the value without restarting.

export function setEnvVar(key: string, value: string): void {
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
