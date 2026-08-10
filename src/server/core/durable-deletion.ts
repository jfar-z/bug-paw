import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { Database } from "../database/database";
import { writeJsonAtomic } from "../storage";

export type DurableDeletionKind = "agent" | "session" | "knowledge-base" | "knowledge-document";

interface DeletionManifest {
  version: 1;
  id: string;
  kind: DurableDeletionKind;
  entityId: string;
  entries: Array<{ original: string; staged: string }>;
}

export interface StagedDeletion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/**
 * 在 SQLite 与文件系统之间提供可重启恢复的删除清单。
 * manifest 先 durable，再移动文件；启动时以 SQLite 实体是否仍存在决定恢复或清理。
 */
export class DurableDeletionCoordinator {
  private readonly rootDir: string;
  private readonly transactionDir: string;

  constructor(rootDir: string, transactionDir: string, private readonly database: Database) {
    this.rootDir = resolve(rootDir);
    this.transactionDir = resolve(transactionDir);
  }

  /** 暂存一组同一实体拥有的文件或目录。 */
  async stage(kind: DurableDeletionKind, entityId: string, originals: string[]): Promise<StagedDeletion> {
    const id = randomUUID();
    const workingDir = join(this.transactionDir, id);
    const unique = [...new Set(originals.map((path) => this.assertAllowed(path)))];
    const manifest: DeletionManifest = {
      version: 1,
      id,
      kind,
      entityId,
      entries: unique.map((original, index) => ({ original, staged: join("staged", String(index)) })),
    };
    await mkdir(join(workingDir, "staged"), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(join(workingDir, "manifest.json"), manifest);
    try {
      for (const entry of manifest.entries) {
        if (!await exists(entry.original)) continue;
        await rename(entry.original, join(workingDir, entry.staged));
      }
    } catch (error) {
      await this.restore(workingDir, manifest).catch(() => undefined);
      throw error;
    }
    let completed = false;
    return {
      commit: async () => {
        if (completed) return;
        completed = true;
        // SQLite 已提交后，清理失败由启动恢复继续完成，不能把成功删除伪装成失败。
        await rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
      },
      rollback: async () => {
        if (completed) return;
        await this.restore(workingDir, manifest);
        completed = true;
      },
    };
  }

  /** 启动时恢复未提交删除，并清理 SQLite 已提交删除留下的暂存数据。 */
  async recover(): Promise<void> {
    await mkdir(this.transactionDir, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.transactionDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "quarantine") continue;
      const workingDir = join(this.transactionDir, entry.name);
      let manifest: DeletionManifest;
      try {
        manifest = JSON.parse(await readFile(join(workingDir, "manifest.json"), "utf8")) as DeletionManifest;
        this.validateManifest(manifest);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && isTransactionId(entry.name)) {
          // manifest 在任何业务文件移动前发布；无 manifest 的 UUID 目录只含空 staging，可安全清理。
          await rm(workingDir, { recursive: true, force: true });
          continue;
        }
        const quarantine = join(this.transactionDir, "quarantine", `${Date.now()}-${entry.name}`);
        await mkdir(dirname(quarantine), { recursive: true, mode: 0o700 });
        await rename(workingDir, quarantine);
        continue;
      }
      if (this.entityExists(manifest.kind, manifest.entityId)) await this.restore(workingDir, manifest);
      else await rm(workingDir, { recursive: true, force: true });
    }
  }

  private entityExists(kind: DurableDeletionKind, entityId: string): boolean {
    const queries: Record<DurableDeletionKind, string> = {
      agent: "SELECT 1 AS found FROM agents WHERE id = ?",
      session: "SELECT 1 AS found FROM sessions WHERE id = ?",
      "knowledge-base": "SELECT 1 AS found FROM knowledge_bases WHERE id = ?",
      "knowledge-document": "SELECT 1 AS found FROM knowledge_documents WHERE id = ?",
    };
    return Boolean(this.database.readOne<{ found: number }>(queries[kind], [entityId]));
  }

  private async restore(workingDir: string, manifest: DeletionManifest): Promise<void> {
    for (const entry of [...manifest.entries].reverse()) {
      const original = this.assertAllowed(entry.original);
      const staged = join(workingDir, entry.staged);
      if (!await exists(staged)) continue;
      await mkdir(dirname(original), { recursive: true, mode: 0o700 });
      await rename(staged, original);
    }
    await rm(workingDir, { recursive: true, force: true });
  }

  private validateManifest(manifest: DeletionManifest): void {
    if (manifest.version !== 1 || !manifest.entityId || !["agent", "session", "knowledge-base", "knowledge-document"].includes(manifest.kind)) {
      throw new Error("删除事务 manifest 无效");
    }
    for (const entry of manifest.entries) {
      this.assertAllowed(entry.original);
      if (!/^staged\/\d+$/u.test(entry.staged)) throw new Error("删除事务暂存路径无效");
    }
  }

  private assertAllowed(path: string): string {
    const candidate = resolve(path);
    const relation = relative(this.rootDir, candidate);
    if (!isAbsolute(path) || !relation || relation === ".." || relation.startsWith("../") || isAbsolute(relation)) {
      throw new TypeError("删除事务路径必须位于数据根目录内");
    }
    return candidate;
  }
}

function isTransactionId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
