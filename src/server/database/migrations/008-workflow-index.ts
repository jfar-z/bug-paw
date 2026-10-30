/** 只创建工作流索引；旧 JSON 数据必须由独立运维脚本导入。 */
export const workflowIndexMigration = {
  version: 8,
  sql: `
    CREATE TABLE workflow_index (
      kind TEXT NOT NULL CHECK(kind IN ('comfyui', 'dag')),
      id TEXT NOT NULL,
      definition_file TEXT NOT NULL,
      summary_json TEXT NOT NULL CHECK(json_valid(summary_json)),
      PRIMARY KEY (kind, id),
      UNIQUE (kind, definition_file)
    ) STRICT;
    CREATE TABLE workflow_index_state (
      kind TEXT PRIMARY KEY CHECK(kind IN ('comfyui', 'dag')),
      revision TEXT NOT NULL
    ) STRICT;
  `,
} as const;
