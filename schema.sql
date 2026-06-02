CREATE TABLE IF NOT EXISTS users (
  phone                TEXT PRIMARY KEY,
  step                 TEXT    NOT NULL DEFAULT 'idle',
  pending_class        TEXT,
  pending_restart      INTEGER NOT NULL DEFAULT 0,
  pending_confirmation TEXT,
  created_at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS classes (
  id                   TEXT PRIMARY KEY,
  user_phone           TEXT NOT NULL REFERENCES users(phone) ON DELETE CASCADE,
  class_key            TEXT NOT NULL,
  name                 TEXT NOT NULL,
  categories           TEXT NOT NULL DEFAULT '[]',
  grades               TEXT NOT NULL DEFAULT '{}',
  canvas_grades        TEXT NOT NULL DEFAULT '{}',
  class_averages       TEXT NOT NULL DEFAULT '{}',
  curve                TEXT NOT NULL DEFAULT '{"type":"none"}',
  dynamic_weights      TEXT,
  canvas_synced        INTEGER NOT NULL DEFAULT 0,
  canvas_id            TEXT,
  canvas_assignment_map TEXT NOT NULL DEFAULT '{}',
  credit_hours         INTEGER,
  last_synced_at       TEXT,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_phone, class_key)
);

CREATE TABLE IF NOT EXISTS config (
  user_phone           TEXT PRIMARY KEY REFERENCES users(phone) ON DELETE CASCADE,
  canvas_connected     INTEGER NOT NULL DEFAULT 0,
  canvas_setup_asked   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS last_action (
  user_phone  TEXT PRIMARY KEY REFERENCES users(phone) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  timestamp   TEXT NOT NULL
);
