/** 身份专属的第二因素、短期挑战与限流数据不进入配置导出。 */
export const totpMigration = {
  version: 7,
  sql: `
    -- 历史会话未记录保持登录选项，轮换时默认采用非持久 Cookie，避免扩大授权。
    ALTER TABLE web_sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE user_totp (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      secret TEXT,
      last_step INTEGER NOT NULL DEFAULT -1,
      generation INTEGER NOT NULL DEFAULT 0,
      enabled_at TEXT
    ) STRICT;
    CREATE TABLE auth_challenges (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('login','setup')),
      session_hash TEXT REFERENCES web_sessions(token_hash) ON DELETE CASCADE,
      secret TEXT,
      generation INTEGER NOT NULL,
      remember INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at);
    CREATE UNIQUE INDEX idx_auth_setup_session ON auth_challenges(session_hash) WHERE kind = 'setup';
    CREATE TABLE totp_recovery_codes (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      code_hash TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE auth_attempts (
      bucket TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    ) STRICT;
  `,
} as const;
