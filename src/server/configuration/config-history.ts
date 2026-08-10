import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { writeJsonAtomic } from "../storage";
import type { ConfigurationHistoryRepository } from "./configuration-history-repository";
import { SYSTEM_LIMITS } from "../core/limits";

/**
 * 配置变更历史记录。
 */
export interface ConfigHistoryEntry {
  /**
   * 历史记录唯一标识。
   */
  id: string;
  /**
   * ISO 8601 创建时间。
   */
  createdAt: string;
  /**
   * 配置变更作用域。
   */
  scope: "global" | "agent" | "credential" | "resource";
  /**
   * 可选的 Agent、Provider 或资源标识。
   */
  targetId?: string;
  /**
   * 不含敏感值的变更摘要。
   */
  summary: string;
  /**
   * 变更最终结果。
   */
  outcome: "success" | "failed";
  /**
   * 是否存在可恢复的非敏感快照。
   */
  restorable?: boolean;
}

/**
 * 不含凭证的设置快照。
 */
export interface ConfigHistorySnapshot {
  id: string;
  scope: "global" | "agent";
  targetId?: string;
  revision: string;
  value: Record<string, unknown>;
}

/**
 * 凭证操作只能选择固定摘要，禁止把请求正文拼接进历史。
 */
export const CREDENTIAL_HISTORY_SUMMARIES = {
  created: "已配置 Provider 凭证",
  updated: "已更新 Provider 凭证",
  removed: "已删除 Provider 凭证",
  failed: "Provider 凭证操作失败",
} as const;

const CREDENTIAL_SUMMARY_VALUES = new Set<string>(Object.values(CREDENTIAL_HISTORY_SUMMARIES));

/**
 * 删除旧历史中的登录标识，并保持快照目录完全不变。
 *
 * @param historyDir 配置历史目录
 */
export async function migrateLegacyConfigHistory(historyDir: string): Promise<void> {
  await mkdir(historyDir, { recursive: true, mode: 0o700 });
  const files = (await readdir(historyDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name);

  await Promise.all(files.map(async (file) => {
    const path = join(historyDir, file);
    const legacy = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const migrated = selectHistoryEntry(legacy);
    if (JSON.stringify(legacy) !== JSON.stringify(migrated)) {
      await writeJsonAtomic(path, migrated);
    }
  }));
}

/**
 * 用白名单重建历史元数据，避免未知旧字段继续对外暴露。
 *
 * @param value 旧历史元数据
 */
function selectHistoryEntry(value: Record<string, unknown>): ConfigHistoryEntry {
  return {
    id: String(value.id),
    createdAt: String(value.createdAt),
    scope: value.scope as ConfigHistoryEntry["scope"],
    ...(typeof value.targetId === "string" ? { targetId: value.targetId } : {}),
    summary: String(value.summary),
    outcome: value.outcome as ConfigHistoryEntry["outcome"],
    ...(typeof value.restorable === "boolean" ? { restorable: value.restorable } : {}),
  };
}

/**
 * 将非敏感配置历史保存为独立的 owner-only JSON 文件。
 */
export class ConfigHistory {
  /**
   * 历史文件目录。
   */
  private readonly historyDir: string;

  /** SQLite 历史索引；未注入时仅用于旧存储兼容测试。 */
  private readonly repository?: ConfigurationHistoryRepository;

  /** 当前进程尚未写入索引的快照元数据。 */
  private readonly pendingSnapshots = new Map<string, ConfigHistorySnapshot>();

  /**
   * 创建配置历史存储。
   *
   * @param historyDir 历史文件目录
   */
  constructor(historyDir: string, repository?: ConfigurationHistoryRepository) {
    this.historyDir = historyDir;
    this.repository = repository;
  }

  /**
   * 记录一条已经脱敏的配置变更历史。
   *
   * @param entry 历史记录
   */
  async record(entry: ConfigHistoryEntry): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) {
      throw new TypeError("历史记录 ID 格式无效");
    }
    if (!Number.isFinite(Date.parse(entry.createdAt))) {
      throw new TypeError("历史记录时间格式无效");
    }
    if (entry.scope === "credential" && !CREDENTIAL_SUMMARY_VALUES.has(entry.summary)) {
      throw new TypeError("凭证历史必须使用固定摘要");
    }

    if (this.repository) {
      const snapshot = this.pendingSnapshots.get(entry.id);
      this.pendingSnapshots.delete(entry.id);
      await this.repository.append({
        id: entry.id,
        revision: snapshot?.revision ?? "",
        snapshotPath: snapshot ? join(this.historyDir, "snapshots", `${entry.id}.json`) : "",
        createdAt: entry.createdAt,
        metadata: entry as unknown as Record<string, unknown>,
      });
      const removed = await this.repository.prune(SYSTEM_LIMITS.configurationHistoryEntries);
      await Promise.allSettled(removed.flatMap((record) => record.snapshotPath && this.isOwnedSnapshot(record.snapshotPath)
        ? [rm(record.snapshotPath, { force: true })]
        : []));
      return;
    }
    const timestamp = entry.createdAt.replace(/[^0-9A-Za-z]/g, "-");
    await writeJsonAtomic(join(this.historyDir, `${timestamp}-${entry.id}.json`), entry);
  }

  /**
   * 按时间倒序列出脱敏历史元数据。
   */
  async list(): Promise<ConfigHistoryEntry[]> {
    if (this.repository) {
      await this.reconcileSnapshots();
      return (await this.repository.list()).map((record) => selectHistoryEntry(record.metadata ?? {}));
    }
    await mkdir(this.historyDir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.historyDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
    const entries = await Promise.all(files.map(async (file) => JSON.parse(await readFile(join(this.historyDir, file), "utf8")) as ConfigHistoryEntry));
    return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * 保存不含凭证的设置恢复快照。
   *
   * @param snapshot 设置文件旧值与旧 revision
   */
  async recordSnapshot(snapshot: ConfigHistorySnapshot): Promise<void> {
    assertHistoryId(snapshot.id);
    await writeJsonAtomic(join(this.historyDir, "snapshots", `${snapshot.id}.json`), snapshot);
    this.pendingSnapshots.set(snapshot.id, snapshot);
  }

  /**
   * 读取恢复快照；内容只在服务端参与重新校验。
   *
   * @param id 历史标识
   */
  async getSnapshot(id: string): Promise<ConfigHistorySnapshot | undefined> {
    assertHistoryId(id);
    try {
      const indexed = await this.repository?.find(id);
      const path = indexed?.snapshotPath || join(this.historyDir, "snapshots", `${id}.json`);
      return JSON.parse(await readFile(path, "utf8")) as ConfigHistorySnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** 启动时清理数据库已淘汰但上次文件删除未完成的孤儿快照。 */
  async reconcileSnapshots(): Promise<void> {
    if (!this.repository) return;
    const snapshotDir = join(this.historyDir, "snapshots");
    await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
    const referenced = new Set((await this.repository.list()).map((record) => resolve(record.snapshotPath)).filter((path) => this.isOwnedSnapshot(path)));
    for (const entry of await readdir(snapshotDir, { withFileTypes: true })) {
      const path = resolve(snapshotDir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".json") && !referenced.has(path)) await rm(path, { force: true });
    }
  }

  private isOwnedSnapshot(path: string): boolean {
    const root = resolve(this.historyDir, "snapshots");
    const relation = relative(root, resolve(path));
    return Boolean(relation) && relation !== ".." && !relation.startsWith("../") && !isAbsolute(relation);
  }
}

function assertHistoryId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new TypeError("历史记录 ID 格式无效");
}
