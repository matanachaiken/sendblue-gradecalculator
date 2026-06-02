// src/db.ts — SQLite abstraction layer. All SQL lives here.
// To swap to Supabase: replace this file only. storage.ts stays identical.
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ClassData, UserState, PendingConfirmation, Config, LastAction } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const DB_PATH = process.env.DB_PATH ?? './data/grade-brain.db';

if (DB_PATH !== ':memory:') {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Read schema relative to compiled dist/ — one level up is repo root
const schemaPath = new URL('../schema.sql', import.meta.url).pathname;
sqlite.exec(readFileSync(schemaPath, 'utf8'));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ensureUser(phone: string): void {
  sqlite.prepare('INSERT OR IGNORE INTO users (phone) VALUES (?)').run(phone);
}

// Row from users table → UserState
function rowToUserState(row: Record<string, unknown>): UserState {
  const state: UserState = {
    step: (row.step as string) || 'idle',
    pendingClass: (row.pending_class as string | null) ?? null,
  };
  if (row.pending_restart) state.pendingRestart = true;
  if (row.pending_confirmation) {
    try {
      state.pendingConfirmation = JSON.parse(row.pending_confirmation as string) as PendingConfirmation;
    } catch { /* ignore */ }
  }
  return state;
}

// DB row → ClassData
interface ClassRow {
  class_key: string;
  name: string;
  categories: string;
  grades: string;
  canvas_grades: string;
  class_averages: string;
  curve: string;
  dynamic_weights: string | null;
  canvas_synced: number;
  canvas_id: string | null;
  canvas_assignment_map: string;
  credit_hours: number | null;
  last_synced_at: string | null;
}

function rowToClassData(row: ClassRow): ClassData {
  const cd: ClassData = {
    name: row.name,
    categories: JSON.parse(row.categories) as ClassData['categories'],
    grades: JSON.parse(row.grades) as Record<string, number[]>,
    canvasGrades: JSON.parse(row.canvas_grades) as Record<string, number[]>,
    classAverages: JSON.parse(row.class_averages) as Record<string, number>,
    curve: JSON.parse(row.curve) as ClassData['curve'],
    dynamicWeights: row.dynamic_weights ? JSON.parse(row.dynamic_weights) as ClassData['dynamicWeights'] : null,
    canvasSynced: row.canvas_synced === 1,
    canvasId: row.canvas_id != null ? Number(row.canvas_id) : null,
    canvasAssignmentMap: JSON.parse(row.canvas_assignment_map) as Record<string, string | null>,
    creditHours: row.credit_hours ?? undefined,
    lastSyncedAt: row.last_synced_at ?? undefined,
  };
  return cd;
}

// ClassData → DB params object
function classDataToRow(phone: string, key: string, data: ClassData) {
  return {
    user_phone: phone,
    class_key: key,
    name: data.name,
    categories: JSON.stringify(data.categories),
    grades: JSON.stringify(data.grades),
    canvas_grades: JSON.stringify(data.canvasGrades ?? {}),
    class_averages: JSON.stringify(data.classAverages ?? {}),
    curve: JSON.stringify(data.curve),
    dynamic_weights: data.dynamicWeights != null ? JSON.stringify(data.dynamicWeights) : null,
    canvas_synced: data.canvasSynced ? 1 : 0,
    canvas_id: data.canvasId != null ? String(data.canvasId) : null,
    canvas_assignment_map: JSON.stringify(data.canvasAssignmentMap ?? {}),
    credit_hours: data.creditHours ?? null,
    last_synced_at: data.lastSyncedAt ?? null,
    updated_at: new Date().toISOString(),
  };
}

// ─── User / State ─────────────────────────────────────────────────────────────

export function dbGetUserState(phone: string): UserState {
  ensureUser(phone);
  const row = sqlite.prepare('SELECT step, pending_class, pending_restart, pending_confirmation FROM users WHERE phone = ?').get(phone) as Record<string, unknown> | undefined;
  if (!row) return { step: 'idle', pendingClass: null };
  return rowToUserState(row);
}

export function dbSetUserState(phone: string, state: UserState): void {
  ensureUser(phone);
  sqlite.prepare(`
    UPDATE users SET
      step = ?,
      pending_class = ?,
      pending_restart = ?,
      pending_confirmation = ?
    WHERE phone = ?
  `).run(
    state.step,
    state.pendingClass ?? null,
    state.pendingRestart ? 1 : 0,
    state.pendingConfirmation ? JSON.stringify(state.pendingConfirmation) : null,
    phone
  );
}

export function dbSetPendingConfirmation(phone: string, pc: PendingConfirmation): void {
  ensureUser(phone);
  sqlite.prepare(`
    UPDATE users SET pending_confirmation = ? WHERE phone = ?
  `).run(JSON.stringify(pc), phone);
}

export function dbClearPendingConfirmation(phone: string): void {
  ensureUser(phone);
  sqlite.prepare('UPDATE users SET pending_confirmation = NULL WHERE phone = ?').run(phone);
}

// ─── Classes ──────────────────────────────────────────────────────────────────

export function dbGetAllClasses(phone: string): Record<string, ClassData> {
  ensureUser(phone);
  const rows = sqlite.prepare('SELECT * FROM classes WHERE user_phone = ?').all(phone) as Array<ClassRow & { class_key: string }>;
  const result: Record<string, ClassData> = {};
  for (const row of rows) {
    result[row.class_key] = rowToClassData(row);
  }
  return result;
}

export function dbGetClass(phone: string, key: string): ClassData | null {
  ensureUser(phone);
  const row = sqlite.prepare('SELECT * FROM classes WHERE user_phone = ? AND class_key = ?').get(phone, key) as (ClassRow & { class_key: string }) | undefined;
  if (!row) return null;
  return rowToClassData(row);
}

export function dbSaveClass(phone: string, key: string, data: ClassData): void {
  ensureUser(phone);
  const row = classDataToRow(phone, key, data);
  // Check if row exists to decide whether to generate a new ID
  const existing = sqlite.prepare('SELECT id FROM classes WHERE user_phone = ? AND class_key = ?').get(phone, key) as { id: string } | undefined;
  if (existing) {
    sqlite.prepare(`
      UPDATE classes SET
        name = @name,
        categories = @categories,
        grades = @grades,
        canvas_grades = @canvas_grades,
        class_averages = @class_averages,
        curve = @curve,
        dynamic_weights = @dynamic_weights,
        canvas_synced = @canvas_synced,
        canvas_id = @canvas_id,
        canvas_assignment_map = @canvas_assignment_map,
        credit_hours = @credit_hours,
        last_synced_at = @last_synced_at,
        updated_at = @updated_at
      WHERE user_phone = @user_phone AND class_key = @class_key
    `).run(row);
  } else {
    const id = crypto.randomUUID();
    sqlite.prepare(`
      INSERT INTO classes (
        id, user_phone, class_key, name, categories, grades, canvas_grades,
        class_averages, curve, dynamic_weights, canvas_synced, canvas_id,
        canvas_assignment_map, credit_hours, last_synced_at, updated_at
      ) VALUES (
        @id, @user_phone, @class_key, @name, @categories, @grades, @canvas_grades,
        @class_averages, @curve, @dynamic_weights, @canvas_synced, @canvas_id,
        @canvas_assignment_map, @credit_hours, @last_synced_at, @updated_at
      )
    `).run({ id, ...row });
  }
}

export function dbDeleteClass(phone: string, key: string): void {
  sqlite.prepare('DELETE FROM classes WHERE user_phone = ? AND class_key = ?').run(phone, key);
}

// ─── Config ───────────────────────────────────────────────────────────────────

export function dbGetConfig(phone: string): Config {
  ensureUser(phone);
  const row = sqlite.prepare('SELECT canvas_connected, canvas_setup_asked FROM config WHERE user_phone = ?').get(phone) as { canvas_connected: number; canvas_setup_asked: number } | undefined;
  if (!row) return { canvasConnected: false, canvasSetupAsked: false };
  return {
    canvasConnected: row.canvas_connected === 1,
    canvasSetupAsked: row.canvas_setup_asked === 1,
  };
}

export function dbSaveConfig(phone: string, config: Config): void {
  ensureUser(phone);
  sqlite.prepare(`
    INSERT INTO config (user_phone, canvas_connected, canvas_setup_asked)
    VALUES (?, ?, ?)
    ON CONFLICT(user_phone) DO UPDATE SET
      canvas_connected = excluded.canvas_connected,
      canvas_setup_asked = excluded.canvas_setup_asked
  `).run(phone, config.canvasConnected ? 1 : 0, config.canvasSetupAsked ? 1 : 0);
}

// ─── Last Action ──────────────────────────────────────────────────────────────

export function dbSaveLastAction(phone: string, action: Omit<LastAction, 'timestamp'>): void {
  ensureUser(phone);
  const full = { ...action, timestamp: new Date().toISOString() } as LastAction;
  sqlite.prepare(`
    INSERT INTO last_action (user_phone, action, timestamp)
    VALUES (?, ?, ?)
    ON CONFLICT(user_phone) DO UPDATE SET
      action = excluded.action,
      timestamp = excluded.timestamp
  `).run(phone, JSON.stringify(full), full.timestamp);
}

export function dbGetLastAction(phone: string): LastAction | null {
  const row = sqlite.prepare('SELECT action FROM last_action WHERE user_phone = ?').get(phone) as { action: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.action) as LastAction;
  } catch {
    return null;
  }
}

export function dbClearLastAction(phone: string): void {
  sqlite.prepare('DELETE FROM last_action WHERE user_phone = ?').run(phone);
}

// ─── Reset ────────────────────────────────────────────────────────────────────

export function dbResetClasses(phone: string): void {
  sqlite.prepare('DELETE FROM classes WHERE user_phone = ?').run(phone);
  sqlite.prepare('DELETE FROM last_action WHERE user_phone = ?').run(phone);
}

export function dbResetAll(phone: string): void {
  // CASCADE deletes classes, config, last_action
  sqlite.prepare('DELETE FROM users WHERE phone = ?').run(phone);
}

// ─── Test Helper ──────────────────────────────────────────────────────────────

export function dbResetUser(phone: string): void {
  dbResetAll(phone);
}
