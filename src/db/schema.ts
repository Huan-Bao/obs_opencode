export const schemaSQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS launches (
  launch_id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  root_session_id TEXT,
  mode TEXT NOT NULL,
  command_json TEXT NOT NULL,
  cwd TEXT NOT NULL,
  server_url TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  pid INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  exit_code INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  launch_id TEXT,
  parent_session_id TEXT,
  project_id TEXT,
  workspace_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  slug TEXT,
  directory TEXT,
  path TEXT,
  agent TEXT,
  provider_id TEXT,
  model_id TEXT,
  version TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  ended_at INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (adapter, session_id),
  FOREIGN KEY (launch_id) REFERENCES launches(launch_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_launch ON sessions(launch_id);
CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id);

CREATE TABLE IF NOT EXISTS events (
  event_pk INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  launch_id TEXT,
  seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  message_id TEXT,
  part_id TEXT,
  call_id TEXT,
  raw_json TEXT NOT NULL,
  UNIQUE(adapter, event_id),
  UNIQUE(adapter, session_id, seq),
  FOREIGN KEY (adapter, session_id) REFERENCES sessions(adapter, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(adapter, session_id, event_time, seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

CREATE TABLE IF NOT EXISTS messages (
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  parent_message_id TEXT,
  role TEXT NOT NULL,
  agent TEXT,
  provider_id TEXT,
  model_id TEXT,
  finish_reason TEXT,
  cost REAL NOT NULL DEFAULT 0,
  tokens_input INTEGER NOT NULL DEFAULT 0,
  tokens_output INTEGER NOT NULL DEFAULT 0,
  tokens_reasoning INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0,
  tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(adapter, message_id),
  FOREIGN KEY(adapter, session_id) REFERENCES sessions(adapter, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(adapter, session_id, created_at);

CREATE TABLE IF NOT EXISTS parts (
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  part_id TEXT NOT NULL,
  part_type TEXT NOT NULL,
  call_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_text TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(adapter, part_id),
  FOREIGN KEY(adapter, message_id) REFERENCES messages(adapter, message_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_parts_session ON parts(adapter, session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_parts_type ON parts(part_type);

CREATE TABLE IF NOT EXISTS tool_calls (
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  part_id TEXT,
  call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT,
  input_json TEXT,
  output_text TEXT,
  error_json TEXT,
  metadata_json TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  duration_ms INTEGER,
  raw_json TEXT NOT NULL,
  PRIMARY KEY(adapter, call_id),
  FOREIGN KEY(adapter, session_id) REFERENCES sessions(adapter, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(adapter, session_id, started_at);

CREATE TABLE IF NOT EXISTS session_diffs (
  diff_id INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  message_id TEXT,
  file_path TEXT,
  additions INTEGER,
  deletions INTEGER,
  raw_json TEXT NOT NULL,
  UNIQUE(adapter, session_id, message_id, file_path),
  FOREIGN KEY(adapter, session_id) REFERENCES sessions(adapter, session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_reviews (
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unreviewed'
    CHECK(status IN ('unreviewed','reviewing','approved','flagged')),
  risk_level TEXT NOT NULL DEFAULT 'none'
    CHECK(risk_level IN ('none','low','medium','high','critical')),
  reviewer TEXT,
  summary TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(adapter, session_id),
  FOREIGN KEY(adapter, session_id) REFERENCES sessions(adapter, session_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_annotations (
  annotation_id TEXT PRIMARY KEY,
  adapter TEXT NOT NULL,
  session_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  risk_level TEXT NOT NULL DEFAULT 'none'
    CHECK(risk_level IN ('none','low','medium','high','critical')),
  tags_json TEXT NOT NULL DEFAULT '[]',
  comment TEXT NOT NULL DEFAULT '',
  reviewer TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(adapter, session_id) REFERENCES sessions(adapter, session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_annotations_target ON audit_annotations(adapter, session_id, target_type, target_id);

CREATE VIRTUAL TABLE IF NOT EXISTS trace_fts USING fts5(
  adapter UNINDEXED,
  session_id UNINDEXED,
  entity_type UNINDEXED,
  entity_id UNINDEXED,
  content,
  tokenize = 'unicode61'
);
`;
