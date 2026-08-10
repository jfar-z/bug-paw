import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Database } from "../database/database";
import type { DataPaths } from "../paths";

/**
 * 清理首轮响应落盘前崩溃留下的无事实源 Session。
 *
 * Pi 只在首个 Assistant 消息完成后创建 JSONL；没有 JSONL 的 SQLite 行与运行检查点无法恢复，
 * 因此启动时采用明确的删除策略，避免形成不可打开、不可删除的 ghost Session。
 */
export async function reconcileUnpersistedSessions(paths: DataPaths, database: Database): Promise<void> {
  const rows = database.read<{ id: string; agent_id: string }>("SELECT id, agent_id FROM sessions");
  const filesByAgent = new Map<string, Set<string>>();
  for (const { id, agent_id: agentId } of rows) {
    let files = filesByAgent.get(agentId);
    if (!files) {
      files = new Set(await readdir(join(paths.piDir, "sessions", agentId)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      }));
      filesByAgent.set(agentId, files);
    }
    const persisted = matchesSessionFile(files, id);
    if (persisted) continue;
    database.write("DELETE FROM sessions WHERE id = ?", [id]);
    await rm(join(paths.runDir, `${id}.json`), { force: true });
  }
}

/** 定时任务等持久化引用只能绑定已经具有 Pi JSONL 事实源的 Session。 */
export async function hasPersistedSessionFile(paths: DataPaths, agentId: string, sessionId: string): Promise<boolean> {
  const files = await readdir(join(paths.piDir, "sessions", agentId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return matchesSessionFile(new Set(files), sessionId);
}

/** 兼容 Pi 的时间戳文件名和测试/迁移使用的直接文件名。 */
function matchesSessionFile(files: ReadonlySet<string>, sessionId: string): boolean {
  return [...files].some((file) => file === `${sessionId}.jsonl` || file.endsWith(`_${sessionId}.jsonl`));
}
