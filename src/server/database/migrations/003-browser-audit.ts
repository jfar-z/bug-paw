/** 为浏览器操作创建不含页面内容的最小审计表。 */
export const browserAuditMigration = {
  version: 3,
  sql: `
    CREATE TABLE IF NOT EXISTS browser_audit_events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      origin TEXT,
      final_origin TEXT,
      decision TEXT NOT NULL CHECK(decision IN ('allowed', 'blocked', 'failed')),
      error_code TEXT,
      queue_wait_ms INTEGER,
      artifact_path TEXT,
      artifact_mime TEXT,
      artifact_bytes INTEGER,
      artifact_sha256 TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS idx_browser_audit_created
      ON browser_audit_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_browser_audit_agent_created
      ON browser_audit_events(agent_id, created_at DESC);
  `,
} as const;
