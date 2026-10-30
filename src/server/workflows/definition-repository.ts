import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "../database/database";
import { DomainError } from "../core/errors";
import { VersionConflictError } from "../configuration/versioned-json-store";

/** 两种工作流共享文件事务机制，数据通过类型独立分区。 */
export type WorkflowKind = "comfyui" | "dag";

/** 数据库仅保存列表摘要和定义文件定位，不保存节点正文。 */
interface IndexRow extends Record<string, unknown> {
  id: string;
  definition_file: string;
  summary_json: string;
}

/** 写入前落盘的撤销日志；数据库提交标记决定重启后的恢复方向。 */
interface PendingWrite {
  id: string;
  before: string | null;
  revision: string;
}

/**
 * 使用固定 ID 文件和 SQLite 索引管理工作流。
 * 同步临界区内完成文件替换和数据库事务，避免异步读写交错。
 * 创建时间：2026-10-30；作者：jiahua.zhang。
 */
export class DefinitionRepository<T extends { id: string }, S extends { id: string }> {
  /** 每个类型独立的持久撤销日志。 */
  private readonly journal: string;

  /** 注入应用数据库、定义目录及列表摘要投影。 */
  constructor(
    private readonly database: Database,
    private readonly kind: WorkflowKind,
    private readonly directory: string,
    private readonly summarize: (value: T) => S,
  ) {
    this.journal = join(directory, ".pending.json");
  }

  /** 仅查询数据库，列表不读取各工作流定义文件。 */
  list(): { revision: string; items: S[] } {
    this.recover();
    return { revision: this.revision(), items: this.database.read<IndexRow>(
      "SELECT id, definition_file, summary_json FROM workflow_index WHERE kind = ? ORDER BY rowid", [this.kind],
    ).map((row) => JSON.parse(row.summary_json) as S) };
  }

  /** 按 ID 定位并即时读取定义，手动编辑无需清缓存或重启。 */
  get(id: string): T | undefined {
    this.recover();
    this.file(id);
    const row = this.database.readOne<IndexRow>(
      "SELECT id, definition_file, summary_json FROM workflow_index WHERE kind = ? AND id = ?", [this.kind, id],
    );
    if (!row) return undefined;
    if (row.definition_file !== `${id}.json`) throw storageError("工作流索引中的定义文件名与 ID 不一致");
    const content = readOptional(this.file(id));
    if (content === null) throw storageError(`工作流 ${id} 的定义文件缺失`);
    let value: T;
    try { value = JSON.parse(content) as T; }
    catch { throw storageError(`工作流 ${id} 的定义文件不是有效 JSON`); }
    if (!value || value.id !== id) throw storageError(`工作流 ${id} 的定义内容与 ID 不一致`);
    return value;
  }

  /** 保存单个定义；版本冲突在任何文件变化之前拒绝。 */
  save(value: T, expectedRevision?: string): string {
    return this.change(value.id, value, expectedRevision);
  }

  /** 删除单个定义，文件与数据库索引一起提交或恢复。 */
  remove(id: string, expectedRevision?: string): string {
    return this.change(id, undefined, expectedRevision);
  }

  /** 返回集合的并发版本；版本不参与定义文件命名或内容校验。 */
  private revision(): string {
    return this.database.readOne<{ revision: string }>(
      "SELECT revision FROM workflow_index_state WHERE kind = ?", [this.kind],
    )?.revision ?? "0";
  }

  /** 只允许稳定文件名，阻止路径穿越及保留文件名碰撞。 */
  private file(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(id)) {
      throw new DomainError("VALIDATION_FAILED", "工作流 ID 只能包含字母、数字、下划线和连字符，最多 120 字符");
    }
    return join(this.directory, `${id}.json`);
  }

  /** 持久日志先于文件变更；数据库事务失败或进程中断均可恢复。 */
  private change(id: string, value: T | undefined, expectedRevision?: string): string {
    this.recover();
    const path = this.file(id);
    const current = this.revision();
    if (expectedRevision !== undefined && current !== expectedRevision) throw new VersionConflictError(expectedRevision, current);
    const summary = value === undefined ? undefined : JSON.stringify(this.summarize(value));
    const content = value === undefined ? null : `${JSON.stringify(value, null, 2)}\n`;
    const pending: PendingWrite = { id, before: readOptional(path), revision: randomUUID() };
    atomicText(this.journal, `${JSON.stringify(pending)}\n`);
    try {
      this.database.transaction(() => {
        if (content === null) removeFile(path);
        else atomicText(path, content);
        if (summary === undefined) {
          this.database.write("DELETE FROM workflow_index WHERE kind = ? AND id = ?", [this.kind, id]);
        } else {
          this.database.write(`INSERT INTO workflow_index(kind, id, definition_file, summary_json) VALUES (?, ?, ?, ?)
            ON CONFLICT(kind, id) DO UPDATE SET definition_file=excluded.definition_file, summary_json=excluded.summary_json`,
          [this.kind, id, `${id}.json`, summary]);
        }
        this.database.write(`INSERT INTO workflow_index_state(kind, revision) VALUES (?, ?)
          ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision`, [this.kind, pending.revision]);
      });
    } catch (error) {
      this.recover();
      throw error;
    }
    this.recover();
    return pending.revision;
  }

  /** 只恢复本存储自身未完成的写事务，不读取或迁移旧聚合文件。 */
  private recover(): void {
    const content = readOptional(this.journal);
    if (content === null) return;
    const pending = JSON.parse(content) as PendingWrite;
    if (typeof pending.revision !== "string" || !(pending.before === null || typeof pending.before === "string")) {
      throw storageError("工作流文件事务日志格式无效");
    }
    const path = this.file(pending.id);
    if (this.revision() !== pending.revision) {
      if (pending.before === null) removeFile(path);
      else atomicText(path, pending.before);
    }
    removeFile(this.journal);
  }
}

/** 文件系统细节不进入面向用户的错误信息。 */
function storageError(message: string): DomainError {
  return new DomainError("INTERNAL_ERROR", message);
}

/** 缺失是明确业务状态；拒绝符号链接，其他读取错误继续传播。 */
function readOptional(path: string): string | null {
  try {
    if (!lstatSync(path).isFile()) throw storageError("工作流定义或事务日志必须是普通文件");
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** 同目录原子替换并同步内容与目录项，定义文件使用便于手工编辑的 UTF-8。 */
function atomicText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  // 单实例同步写入；清理上次进程中断留下的同名暂存文件。
  removeFile(temporary);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, content, "utf8"); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

/** 精确删除单个文件并同步目录，缺失文件视为已经完成。 */
function removeFile(path: string): void {
  try { unlinkSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  syncDirectory(dirname(path));
}

/** 保证原子重命名和删除的目录项已持久化。 */
function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}
