CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'student')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS password_resets_expiry_idx ON password_resets(expires_at);

CREATE TABLE IF NOT EXISTS documents (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS documents_collection_created_idx ON documents(collection, created_at DESC);

CREATE TABLE IF NOT EXISTS student_files (
  id TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL
);
