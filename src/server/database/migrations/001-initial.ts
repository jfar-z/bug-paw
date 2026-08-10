/** BugPaw 自有结构化状态的初始 Schema。 */
export const initialMigration = {
  version: 1,
  sql: `
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      password_algorithm TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_path TEXT,
      avatar_media_type TEXT,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      cwd TEXT NOT NULL UNIQUE,
      profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
      sort_order INTEGER NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1),
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TRIGGER IF NOT EXISTS trg_agents_workspace_insert
    BEFORE INSERT ON agents
    WHEN EXISTS (
      SELECT 1 FROM agents
      WHERE cwd = NEW.cwd OR NEW.cwd LIKE cwd || '/%' OR cwd LIKE NEW.cwd || '/%'
    )
    BEGIN
      SELECT RAISE(ABORT, 'agent workspace overlaps');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_agents_workspace_update
    BEFORE UPDATE OF cwd ON agents
    WHEN EXISTS (
      SELECT 1 FROM agents
      WHERE id <> OLD.id AND (cwd = NEW.cwd OR NEW.cwd LIKE cwd || '/%' OR cwd LIKE NEW.cwd || '/%')
    )
    BEGIN
      SELECT RAISE(ABORT, 'agent workspace overlaps');
    END;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      archived_at TEXT,
      display_name TEXT,
      projection_version INTEGER NOT NULL DEFAULT 0 CHECK(projection_version >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
      task_json TEXT NOT NULL CHECK(json_valid(task_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS scheduled_task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      run_json TEXT NOT NULL CHECK(json_valid(run_json)),
      started_at TEXT NOT NULL,
      finished_at TEXT
    ) STRICT;

    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS knowledge_base_agents (
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      PRIMARY KEY(knowledge_base_id, agent_id)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id TEXT PRIMARY KEY,
      knowledge_base_id TEXT NOT NULL REFERENCES knowledge_bases(id) ON DELETE CASCADE,
      document_json TEXT NOT NULL CHECK(json_valid(document_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS configuration_history (
      id TEXT PRIMARY KEY,
      revision TEXT NOT NULL,
      snapshot_path TEXT NOT NULL,
      metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_web_sessions_expires_at ON web_sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_sort_order ON agents(sort_order);
    CREATE INDEX IF NOT EXISTS idx_sessions_agent_archived ON sessions(agent_id, archived_at);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_agent ON scheduled_tasks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_session ON scheduled_tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_task_started ON scheduled_task_runs(task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_runs_started ON scheduled_task_runs(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_base ON knowledge_documents(knowledge_base_id);
    CREATE INDEX IF NOT EXISTS idx_configuration_history_created ON configuration_history(created_at DESC);
  `,
} as const;
