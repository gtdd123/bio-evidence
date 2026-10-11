// Initial BioEvidence authority schema. Further services use these tables rather
// than treating Craft workspace folders or JSONL headers as permission grants.
export const SCHEMA_VERSION = 1;
export const INITIAL_SCHEMA = `
CREATE TABLE service_instance(singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_nonce TEXT, owner_pid INTEGER);
CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
 active INTEGER NOT NULL CHECK(active IN(0,1)), administrator INTEGER NOT NULL CHECK(administrator IN(0,1)), revision INTEGER NOT NULL);
CREATE TABLE auth_sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT UNIQUE NOT NULL,
 expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE spaces(scope_key TEXT PRIMARY KEY, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), owner_id TEXT NOT NULL REFERENCES users(id));
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), revision INTEGER NOT NULL);
CREATE TABLE members(project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN('owner','editor','viewer')), active INTEGER NOT NULL CHECK(active IN(0,1)), PRIMARY KEY(project_id,user_id));
CREATE TABLE bindings(kind TEXT NOT NULL, id TEXT NOT NULL, scope_key TEXT NOT NULL REFERENCES spaces(scope_key), PRIMARY KEY(kind,id));
CREATE TABLE entities(kind TEXT NOT NULL, id TEXT NOT NULL, scope_key TEXT NOT NULL REFERENCES spaces(scope_key),
 payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(kind,id), FOREIGN KEY(kind,id) REFERENCES bindings(kind,id));
CREATE TABLE heads(kind TEXT NOT NULL, entity_id TEXT NOT NULL, record_id TEXT NOT NULL, revision INTEGER NOT NULL,
 policy TEXT, PRIMARY KEY(kind,entity_id), FOREIGN KEY(kind,record_id) REFERENCES entities(kind,id));
CREATE TABLE reviews(kind TEXT NOT NULL, record_id TEXT NOT NULL, decision TEXT NOT NULL, reviewer_id TEXT NOT NULL REFERENCES users(id),
 reviewed_at INTEGER NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(kind,record_id), FOREIGN KEY(kind,record_id) REFERENCES entities(kind,id));
CREATE TABLE root_grants(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL REFERENCES spaces(scope_key), root_path TEXT NOT NULL,
 authority_hash TEXT NOT NULL, active INTEGER NOT NULL);
CREATE TABLE materials(id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES root_grants(id), scope_key TEXT NOT NULL REFERENCES spaces(scope_key),
 metadata TEXT NOT NULL CHECK(json_valid(metadata)));
CREATE TABLE directory_index(grant_id TEXT NOT NULL REFERENCES root_grants(id), id TEXT NOT NULL, relative_path TEXT NOT NULL,
 generation INTEGER NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata)), PRIMARY KEY(grant_id,id));
CREATE TABLE snapshot_blocks(snapshot_id TEXT NOT NULL, block_id TEXT NOT NULL, unit INTEGER NOT NULL, text TEXT NOT NULL,
 locator TEXT NOT NULL CHECK(json_valid(locator)), PRIMARY KEY(snapshot_id,block_id));
CREATE TABLE run_leases(run_id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE run_steps(run_id TEXT NOT NULL, step_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)), PRIMARY KEY(run_id,step_id));
CREATE TABLE run_intents(run_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(run_id,operation_id));
CREATE TABLE projection_journal(sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, operation_id TEXT NOT NULL,
 scope_key TEXT NOT NULL REFERENCES spaces(scope_key), generation INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 hash TEXT NOT NULL, projected INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id,operation_id));
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL, scope_key TEXT, action TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('success','denied','failed')), resource_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE outbox(sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL REFERENCES spaces(scope_key), kind TEXT NOT NULL,
 resource_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
CREATE INDEX entities_scope ON entities(scope_key,kind);
CREATE UNIQUE INDEX one_active_run_per_session ON entities(json_extract(payload,'$.sessionId'))
 WHERE kind='run' AND json_extract(payload,'$.state') IN('queued','running');
CREATE INDEX audit_scope ON audit(scope_key,id);
CREATE INDEX outbox_scope ON outbox(scope_key,sequence);
CREATE INDEX journal_session ON projection_journal(session_id,sequence);
PRAGMA user_version=1;
`;
