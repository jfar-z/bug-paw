import type { Database } from "../database/database";

/** 配置快照在 SQLite 中的可检索索引。 */
export interface ConfigurationHistoryRecord {
  id: string;
  revision: string;
  snapshotPath: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConfigurationHistoryRepository {
  append(record: ConfigurationHistoryRecord): Promise<void>;
  list(): Promise<ConfigurationHistoryRecord[]>;
  find(id: string): Promise<ConfigurationHistoryRecord | undefined>;
  prune(limit: number): Promise<ConfigurationHistoryRecord[]>;
}

interface HistoryRow extends Record<string, unknown> { id: string; revision: string; snapshot_path: string; metadata_json: string; created_at: string }

/** 创建配置历史索引仓库；快照内容仍保存在受控文件中。 */
export function createConfigurationHistoryRepository(database: Database): ConfigurationHistoryRepository {
  return {
    async append(record) {
      database.write(
        "INSERT INTO configuration_history(id, revision, snapshot_path, metadata_json, created_at) VALUES (?, ?, ?, ?, ?)",
        [record.id, record.revision, record.snapshotPath, JSON.stringify(record.metadata ?? {}), record.createdAt],
      );
    },
    async list() {
      return database.read<HistoryRow>("SELECT id, revision, snapshot_path, metadata_json, created_at FROM configuration_history ORDER BY created_at DESC, id DESC").map(toRecord);
    },
    async find(id) {
      const row = database.readOne<HistoryRow>("SELECT id, revision, snapshot_path, metadata_json, created_at FROM configuration_history WHERE id = ?", [id]);
      return row ? toRecord(row) : undefined;
    },
    async prune(limit) {
      return database.transaction(() => {
        const removed = database.read<HistoryRow>(`
          SELECT id, revision, snapshot_path, metadata_json, created_at FROM configuration_history
          WHERE id NOT IN (
            SELECT id FROM configuration_history ORDER BY created_at DESC, id DESC LIMIT ?
          )
        `, [Math.max(0, limit)]).map(toRecord);
        for (const record of removed) database.write("DELETE FROM configuration_history WHERE id = ?", [record.id]);
        return removed;
      });
    },
  };
}

function toRecord(row: HistoryRow): ConfigurationHistoryRecord {
  return {
    id: row.id,
    revision: row.revision,
    snapshotPath: row.snapshot_path,
    createdAt: row.created_at,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
  };
}
