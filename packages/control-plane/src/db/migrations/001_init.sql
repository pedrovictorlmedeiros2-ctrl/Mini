-- Atlantic Host - initial schema
-- Design notes:
--  * IDs are TEXT (uuid) except autoincrement internal tables (migrations).
--  * Every tenant-owned table carries user_id (directly or via server_id) so
--    ownership checks are a single indexed WHERE clause away.
--  * status columns are free TEXT validated in application code against the
--    shared state-machine enums, not DB CHECK constraints, so plan/state
--    additions don't require a migration.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  ram_mb INTEGER NOT NULL,
  cpu_percent INTEGER NOT NULL,
  disk_mb INTEGER NOT NULL,
  pids_limit INTEGER NOT NULL DEFAULT 256,
  max_servers INTEGER NOT NULL DEFAULT 1,
  max_backups INTEGER NOT NULL DEFAULT 3,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'BRL',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hostname TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'default',
  agent_token_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  ram_mb_total INTEGER NOT NULL DEFAULT 0,
  cpu_percent_total INTEGER NOT NULL DEFAULT 0,
  disk_mb_total INTEGER NOT NULL DEFAULT 0,
  ram_mb_reserved INTEGER NOT NULL DEFAULT 0,
  cpu_percent_reserved INTEGER NOT NULL DEFAULT 0,
  disk_mb_reserved INTEGER NOT NULL DEFAULT 0,
  containers_count INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 100,
  last_heartbeat_at TEXT,
  last_metrics_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_nodes_status ON nodes(status);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'PENDING',
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BRL',
  payment_provider TEXT,
  payment_ref TEXT,
  idempotency_key TEXT UNIQUE,
  server_id TEXT,
  server_config_json TEXT NOT NULL DEFAULT '{}',
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE UNIQUE INDEX idx_orders_payment_ref ON orders(payment_provider, payment_ref) WHERE payment_ref IS NOT NULL;

CREATE TABLE servers (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT REFERENCES nodes(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  order_id TEXT REFERENCES orders(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'generic',
  status TEXT NOT NULL DEFAULT 'CREATING',
  container_id TEXT,
  image TEXT NOT NULL DEFAULT 'node:20-alpine',
  start_command TEXT,
  ram_mb INTEGER NOT NULL,
  cpu_percent INTEGER NOT NULL,
  disk_mb INTEGER NOT NULL,
  pids_limit INTEGER NOT NULL DEFAULT 256,
  volume_path TEXT,
  crash_count INTEGER NOT NULL DEFAULT 0,
  suspended_reason TEXT,
  last_health_check_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_servers_user ON servers(user_id);
CREATE INDEX idx_servers_node ON servers(node_id);
CREATE INDEX idx_servers_status ON servers(status);

CREATE TABLE env_vars (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_encrypted TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(server_id, key)
);

CREATE TABLE backups (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PENDING',
  size_bytes INTEGER,
  checksum TEXT,
  storage_path TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX idx_backups_server ON backups(server_id);

CREATE TABLE domains (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL UNIQUE,
  ssl_status TEXT NOT NULL DEFAULT 'PENDING',
  verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_domains_server ON domains(server_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL DEFAULT 'user',
  event TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  metadata_json TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_audit_actor ON audit_log(actor_user_id);
CREATE INDEX idx_audit_event ON audit_log(event);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);
CREATE INDEX idx_audit_created ON audit_log(created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'QUEUED',
  priority INTEGER NOT NULL DEFAULT 5,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_after TEXT NOT NULL DEFAULT (datetime('now')),
  locked_by TEXT,
  locked_at TEXT,
  idempotency_key TEXT UNIQUE,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_status_run_after ON jobs(status, run_after);
CREATE INDEX idx_jobs_type ON jobs(type);

CREATE TABLE rate_limits (
  id TEXT PRIMARY KEY,
  bucket TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(bucket, window_start)
);
