import path from 'node:path';
import Database from 'better-sqlite3';

export type DB = Database.Database;

// v1.3 schema. Older v1.2 columns/tables (review_queue, similarity_edges,
// wikilinks.relation_type/confidence, clusters.label etc.) are kept as
// deprecated remnants to avoid destructive migration on existing dbs;
// runtime code does not read or write them.
const DDL = `
CREATE TABLE IF NOT EXISTS nodes (
  uuid TEXT PRIMARY KEY,
  node_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_by_run TEXT,
  l0_summary TEXT,
  l1_overview TEXT,
  current_path TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  reference_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT,
  superseded_by TEXT,
  superseded_reason TEXT,
  -- derived per-cluster (recomputed each clustering pass)
  cluster_id INTEGER,
  cluster_membership_strength REAL,
  is_cluster_hub INTEGER NOT NULL DEFAULT 0,
  hub_of_cluster INTEGER,
  -- raw 专属
  hub_role_value TEXT,
  hub_role_source TEXT,
  hub_role_reason TEXT,
  -- synthesis 专属(通用)
  synthesis_subtype TEXT,
  trigger_type TEXT,
  cluster_when_created INTEGER,
  compactness_ratio REAL,
  novelty_to_sources REAL,
  self_rating INTEGER,
  -- cluster_review 专属
  reviewed_cluster_id INTEGER,
  validation_status TEXT,
  primary_concentration REAL,
  previous_cluster_review_uuid TEXT,
  inheritance_decision TEXT,
  -- 嵌入指针(v1.3 取消 e_l2;e_l2_id 列保留为 deprecated)
  e_l0_id INTEGER,
  e_l1_id INTEGER,
  e_l2_id INTEGER,
  embedding_model TEXT,
  embedded_at TEXT,
  file_mtime INTEGER,
  body_sha256 TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(node_type);
CREATE INDEX IF NOT EXISTS idx_nodes_cluster ON nodes(cluster_id);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);

-- v1.3 simplified: a wikilink is just a [[uuid]] mention edge between nodes.
-- relation_type / confidence columns from v1.2 remain on disk for backward
-- compat but are unused; new writes only ever populate (source, target).
CREATE TABLE IF NOT EXISTS wikilinks (
  source_uuid TEXT NOT NULL,
  target_uuid TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'mention',
  confidence TEXT NOT NULL DEFAULT 'EXTRACTED',
  PRIMARY KEY (source_uuid, target_uuid, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_wikilinks_target ON wikilinks(target_uuid);

CREATE TABLE IF NOT EXISTS synthesis_sources (
  synthesis_uuid TEXT NOT NULL,
  source_uuid TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (synthesis_uuid, source_uuid)
);
CREATE INDEX IF NOT EXISTS idx_sources_target ON synthesis_sources(source_uuid);

CREATE TABLE IF NOT EXISTS clusters (
  cluster_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  member_count INTEGER NOT NULL,
  centroid_e_l1 BLOB,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  -- v1.3 hub + review state
  hub_uuid TEXT,
  hub_source TEXT,
  friction_count INTEGER NOT NULL DEFAULT 0,
  last_review_at TEXT,
  last_new_member_at TEXT,
  -- v1.2 deprecated columns (kept for backward compat, not written by v1.3 code)
  label TEXT,
  label_source TEXT,
  homogeneous INTEGER NOT NULL DEFAULT 0,
  split_rejected_at TEXT
);

CREATE TABLE IF NOT EXISTS cluster_snapshots (
  snapshot_id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at TEXT NOT NULL,
  cluster_id INTEGER NOT NULL,
  centroid_e_l1 BLOB NOT NULL,
  member_count INTEGER NOT NULL,
  member_uuids TEXT NOT NULL,
  -- v1.3 §6.6 covariance trace for drift detection
  covariance_trace REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_time ON cluster_snapshots(taken_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_cluster ON cluster_snapshots(cluster_id);

CREATE TABLE IF NOT EXISTS query_log (
  query_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  queried_by TEXT NOT NULL,
  query_text TEXT NOT NULL,
  raw_hits TEXT NOT NULL,
  synthesis_hits TEXT NOT NULL,
  raw_after_expansion TEXT NOT NULL,
  final_used TEXT NOT NULL,
  flagged_issues TEXT,
  answer_adopted INTEGER
);
CREATE INDEX IF NOT EXISTS idx_query_time ON query_log(timestamp);

CREATE TABLE IF NOT EXISTS op_log (
  op_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  agent_run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  op_type TEXT NOT NULL,
  args TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_view_hash TEXT NOT NULL,
  after_view_hash TEXT NOT NULL,
  affected_uuids TEXT NOT NULL,
  reverted_by TEXT,
  branch_name TEXT NOT NULL DEFAULT 'main'
);
CREATE INDEX IF NOT EXISTS idx_oplog_time ON op_log(timestamp);
CREATE INDEX IF NOT EXISTS idx_oplog_branch ON op_log(branch_name);
CREATE INDEX IF NOT EXISTS idx_oplog_run ON op_log(agent_run_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_type TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS scheduler_state (
  job_name TEXT PRIMARY KEY,
  last_run_at TEXT,
  next_run_at TEXT,
  last_status TEXT
);

CREATE TABLE IF NOT EXISTS view_layer_state (
  branch_name TEXT PRIMARY KEY,
  last_op_id TEXT,
  snapshot_json TEXT NOT NULL
);

-- v1.3 §7.2 / §9.1 — consultant-side flag queue. Two flag types:
--   specific_issue: a precise complaint about one node (l1_inaccurate, wrong_cluster, ...)
--   cluster_friction: a trend-style "queries in this cluster keep going wrong"
-- Librarian consumes these in background pass / next on_review.
CREATE TABLE IF NOT EXISTS flag_queue (
  flag_id TEXT PRIMARY KEY,
  flag_type TEXT NOT NULL,
  target_uuid TEXT,
  target_cluster_id INTEGER,
  issue_type TEXT,
  description TEXT NOT NULL,
  flagged_at TEXT NOT NULL,
  flagged_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  addressed_by_op_id TEXT,
  addressed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_flag_status ON flag_queue(status);
CREATE INDEX IF NOT EXISTS idx_flag_type ON flag_queue(flag_type);
CREATE INDEX IF NOT EXISTS idx_flag_cluster ON flag_queue(target_cluster_id);

-- v1.3 §11.4 — multi-agent enrolment. agent_id + permissions + api_key_hash.
-- Permissions are JSON array, e.g. ["read","write"] or ["read","write","structural","admin"].
CREATE TABLE IF NOT EXISTS registered_agents (
  agent_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key_hash TEXT NOT NULL,
  permissions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

-- v1.2 deprecated tables — kept on disk for backward compat. v1.3 code does
-- not query or write to them. Drop manually if a clean state is desired.
CREATE TABLE IF NOT EXISTS review_queue (
  review_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  source_uuid TEXT,
  target_uuid TEXT,
  cluster_id INTEGER,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT
);

CREATE TABLE IF NOT EXISTS similarity_edges (
  source_uuid TEXT NOT NULL,
  target_uuid TEXT NOT NULL,
  sim_score REAL NOT NULL,
  computed_at TEXT NOT NULL,
  PRIMARY KEY (source_uuid, target_uuid)
);

-- v2.0 Hermes Optimizer §4.3 — raw CoT traces, TTL-managed, not in default search
CREATE TABLE IF NOT EXISTS reasoning_traces (
  trace_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  agent_run_id TEXT,
  query_id TEXT,
  task_type TEXT,
  trace_content TEXT NOT NULL,
  evidence_uuids TEXT,
  final_answer_summary TEXT,
  outcome TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT
);

-- v2.0 Hermes Optimizer §4.4 — internal + external KB optimization work queue
CREATE TABLE IF NOT EXISTS optimization_queue (
  item_id TEXT PRIMARY KEY,
  problem_type TEXT NOT NULL,
  target_uuid TEXT,
  target_cluster_id INTEGER,
  evidence TEXT,
  proposed_action TEXT,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
`;

// Per-column ALTER TABLE migrations for databases created before these columns
// existed. Each is wrapped in a try/catch keyed on "duplicate column" so the
// run is idempotent. The set covers both v1.2 backward-compat and v1.3 additions.
const MIGRATIONS: string[] = [
  // v1.2 legacy (kept so very old dbs still upgrade through the same code path)
  "ALTER TABLE clusters ADD COLUMN label TEXT",
  "ALTER TABLE clusters ADD COLUMN label_source TEXT",
  "ALTER TABLE clusters ADD COLUMN homogeneous INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE clusters ADD COLUMN split_rejected_at TEXT",
  "ALTER TABLE wikilinks ADD COLUMN relation_type TEXT NOT NULL DEFAULT 'mention'",
  "ALTER TABLE wikilinks ADD COLUMN confidence TEXT NOT NULL DEFAULT 'EXTRACTED'",
  "ALTER TABLE nodes ADD COLUMN body_sha256 TEXT",
  // v1.3 nodes additions
  "ALTER TABLE nodes ADD COLUMN superseded_reason TEXT",
  "ALTER TABLE nodes ADD COLUMN is_cluster_hub INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE nodes ADD COLUMN hub_of_cluster INTEGER",
  "ALTER TABLE nodes ADD COLUMN hub_role_value TEXT",
  "ALTER TABLE nodes ADD COLUMN hub_role_source TEXT",
  "ALTER TABLE nodes ADD COLUMN hub_role_reason TEXT",
  "ALTER TABLE nodes ADD COLUMN reviewed_cluster_id INTEGER",
  "ALTER TABLE nodes ADD COLUMN validation_status TEXT",
  "ALTER TABLE nodes ADD COLUMN primary_concentration REAL",
  "ALTER TABLE nodes ADD COLUMN previous_cluster_review_uuid TEXT",
  "ALTER TABLE nodes ADD COLUMN inheritance_decision TEXT",
  // v1.3 clusters additions
  "ALTER TABLE clusters ADD COLUMN hub_uuid TEXT",
  "ALTER TABLE clusters ADD COLUMN hub_source TEXT",
  "ALTER TABLE clusters ADD COLUMN friction_count INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE clusters ADD COLUMN last_review_at TEXT",
  "ALTER TABLE clusters ADD COLUMN last_new_member_at TEXT",
  // v1.3 cluster_snapshots additions
  "ALTER TABLE cluster_snapshots ADD COLUMN covariance_trace REAL",
  // v1.3 query_log additions
  "ALTER TABLE query_log ADD COLUMN flagged_issues TEXT",
  // v1.3+ hierarchical clustering: parent_cluster_id forms cluster tree.
  // NULL = top-level. LLM meta-clustering populates this each monthly run.
  "ALTER TABLE clusters ADD COLUMN parent_cluster_id INTEGER",
];

// Indexes that depend on columns added by migrations. These are created after
// `applyMigrations` to guarantee the underlying column exists on legacy dbs.
const POST_MIGRATION_INDEXES: string[] = [
  "CREATE INDEX IF NOT EXISTS idx_nodes_body_sha256 ON nodes(body_sha256)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_subtype ON nodes(synthesis_subtype)",
  "CREATE INDEX IF NOT EXISTS idx_nodes_hub ON nodes(is_cluster_hub)",
  "CREATE INDEX IF NOT EXISTS idx_traces_agent_run ON reasoning_traces(agent_run_id)",
  "CREATE INDEX IF NOT EXISTS idx_traces_expires ON reasoning_traces(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_optq_status ON optimization_queue(status)",
];

function applyMigrations(db: DB) {
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (!msg.toLowerCase().includes('duplicate column')) throw err;
    }
  }
  for (const sql of POST_MIGRATION_INDEXES) {
    try {
      db.exec(sql);
    } catch {
      // index creation is best-effort; ignore
    }
  }
}

export function openDb(dataDir: string): DB {
  const db = new Database(path.join(dataDir, 'kb.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);
  applyMigrations(db);
  return db;
}
