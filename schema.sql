CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  lead_minutes INTEGER NOT NULL DEFAULT 15,
  paused INTEGER NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS user_settings (
  chat_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  lead_minutes INTEGER NOT NULL DEFAULT 15,
  paused INTEGER NOT NULL DEFAULT 0,
  schedule TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS user_settings_active ON user_settings(paused, chat_id);
CREATE TABLE IF NOT EXISTS jobs (
  key TEXT PRIMARY KEY,
  done INTEGER NOT NULL DEFAULT 0,
  applied INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL,
  lease_owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_expiry ON jobs(expires_at);
