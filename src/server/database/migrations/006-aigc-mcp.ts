/** 保存外部 MCP 客户端授权和私有上传文件的归属。 */
export const aigcMcpMigration = {
  version: 6,
  sql: `
    CREATE TABLE aigc_mcp_clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      interface_ids_json TEXT NOT NULL CHECK(json_valid(interface_ids_json)),
      operations_json TEXT NOT NULL CHECK(json_valid(operations_json)),
      created_at TEXT NOT NULL,
      revoked_at TEXT
    ) STRICT;
    CREATE TABLE aigc_mcp_uploads (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL REFERENCES aigc_mcp_clients(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX idx_aigc_mcp_uploads_client ON aigc_mcp_uploads(client_id);
  `,
} as const;
