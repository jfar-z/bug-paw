import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import lockfile from "proper-lockfile";

import { writeJsonAtomic } from "../storage";
import { DomainError } from "../core/errors";
import { VersionConflictError } from "./versioned-json-store";

/**
 * 单个配置文件的事务变更。
 */
export interface ConfigFileChange {
  /**
   * 数据根目录内的绝对目标路径。
   */
  path: string;
  /**
   * 调用方最近读取到的文件版本。
   */
  expectedRevision: string;
  /**
   * 下一个完整 UTF-8 内容；null 表示删除文件。
   */
  nextContent: string | null;
  /**
   * 是否包含凭证等敏感内容。
   */
  sensitive: boolean;
}

/**
 * 多文件配置事务公开接口。
 */
export interface ConfigTransactionService {
  /**
   * 原子语义地提交一组配置文件变更。
   *
   * @param changes 文件变更列表
   */
  run(changes: ConfigFileChange[]): Promise<void>;
  /** 提交配置文件变更的统一新接口。 */
  execute(changes: ConfigFileChange[]): Promise<void>;
  /**
   * 回滚所有尚未清理的事务。
   */
  recover(): Promise<void>;
}

/**
 * 原子文件替换函数。
 */
export type ConfigFileReplacer = (path: string, content: string | Buffer) => Promise<void>;

/**
 * 配置事务依赖。
 */
export interface ConfigTransactionOptions {
  /**
   * 允许写入的持久化数据根目录。
   */
  rootDir: string;
  /**
   * 事务清单和恢复副本目录。
   */
  transactionDir: string;
  /**
   * 可替换的底层原子写入器，便于隔离文件系统故障。
   */
  replaceFile?: ConfigFileReplacer;
  /** 可替换的事务元数据写入器，用于故障注入和 durable marker。 */
  writeMetadata?: (path: string, value: unknown) => Promise<void>;
}

interface TransactionManifestEntry {
  /**
   * 目标文件绝对路径。
   */
  path: string;
  /**
   * 事务开始时文件是否存在。
   */
  existed: boolean;
  /**
   * 恢复副本的相对文件名。
   */
  backupFile?: string;
  /**
   * 文件是否包含敏感信息。
   */
  sensitive: boolean;
}

interface TransactionManifest {
  /**
   * 清单格式版本。
   */
  version: 1;
  /**
   * 事务唯一标识。
   */
  id: string;
  /**
   * 事务创建时间。
   */
  createdAt: string;
  /**
   * 恢复所需的文件元数据，不包含新旧文件内容。
   */
  entries: TransactionManifestEntry[];
}

interface CurrentFile {
  /**
   * 文件是否存在。
   */
  exists: boolean;
  /**
   * 当前原始字节。
   */
  content?: Buffer;
  /**
   * 当前文件版本。
   */
  revision: string;
}

const MISSING_REVISION = createHash("sha256").update("pi-agent:missing-file", "utf8").digest("hex");

/**
 * 读取配置文件的原始字节和版本。
 *
 * @param filePath 配置文件路径
 */
async function readCurrentFile(filePath: string): Promise<CurrentFile> {
  try {
    const content = await readFile(filePath);
    return {
      exists: true,
      content,
      revision: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, revision: MISSING_REVISION };
    }
    throw error;
  }
}

/**
 * 原子写入完整文件内容并固定权限。
 *
 * @param filePath 目标路径
 * @param content 完整文件内容
 */
async function replaceFileAtomic(filePath: string, content: string | Buffer): Promise<void> {
  const directory = dirname(filePath);
  const temporaryFile = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(temporaryFile, "wx", 0o600);

  try {
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    await rename(temporaryFile, filePath);
    await chmod(filePath, 0o600);
    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 确认目标是数据根目录内的绝对路径。
 *
 * @param rootDir 数据根目录
 * @param candidate 目标路径
 */
async function resolveAllowedPath(rootDir: string, candidate: string): Promise<string> {
  if (!isAbsolute(candidate)) {
    throw new TypeError("配置事务目标必须使用绝对路径");
  }
  const resolvedCandidate = resolve(candidate);
  const relativePath = relative(rootDir, resolvedCandidate);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new TypeError("配置事务目标必须位于数据根目录内");
  }

  const realRoot = await realpath(rootDir);
  let existingAncestor = resolvedCandidate;
  while (true) {
    try {
      const realAncestor = await realpath(existingAncestor);
      const realRelativePath = relative(realRoot, realAncestor);
      if (realRelativePath.startsWith("..") || isAbsolute(realRelativePath)) {
        throw new TypeError("配置事务目标必须位于数据根目录内，且不能通过符号链接越界");
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) {
        throw error;
      }
      existingAncestor = parent;
    }
  }
  return resolvedCandidate;
}

/**
 * 多文件配置事务实现。
 */
export class ConfigTransaction implements ConfigTransactionService {
  /**
   * 规范化后的数据根目录。
   */
  private readonly rootDir: string;
  /**
   * 事务工作目录。
   */
  private readonly transactionDir: string;
  /**
   * 底层原子文件替换函数。
   */
  private readonly replaceFile: ConfigFileReplacer;
  /** 事务 manifest 与提交标记写入器。 */
  private readonly writeMetadata: (path: string, value: unknown) => Promise<void>;

  /**
   * 创建配置事务服务。
   *
   * @param options 数据路径与文件替换依赖
   */
  constructor(options: ConfigTransactionOptions) {
    this.rootDir = resolve(options.rootDir);
    this.transactionDir = resolve(options.transactionDir);
    this.replaceFile = options.replaceFile ?? replaceFileAtomic;
    this.writeMetadata = options.writeMetadata ?? writeJsonAtomic;
  }

  /**
   * 提交一组配置文件变更。
   *
   * @param changes 文件变更列表
   */
  async run(changes: ConfigFileChange[]): Promise<void> {
    return this.execute(changes);
  }

  /** 提交一组配置文件变更，并在返回前完成提交或回滚。 */
  async execute(changes: ConfigFileChange[]): Promise<void> {
    if (changes.length === 0) {
      return;
    }

    const normalizedChanges = await Promise.all(
      changes.map(async (change) => ({
        ...change,
        path: await resolveAllowedPath(this.rootDir, change.path),
      })),
    );
    if (new Set(normalizedChanges.map(({ path }) => path)).size !== normalizedChanges.length) {
      throw new TypeError("同一事务不能重复修改同一个文件");
    }

    await mkdir(this.transactionDir, { recursive: true, mode: 0o700 });
    const releases: Array<() => Promise<void>> = [];
    const sortedPaths = normalizedChanges.map(({ path }) => path).sort();
    try {
      for (const filePath of sortedPaths) {
        const lockTarget = join(dirname(filePath), `.${basename(filePath)}.lock-target`);
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
        releases.push(
          await lockfile.lock(lockTarget, {
            realpath: false,
            retries: { retries: 20, factor: 1.2, minTimeout: 5, maxTimeout: 50 },
          }),
        );
      }

      const currentFiles = await Promise.all(normalizedChanges.map(({ path }) => readCurrentFile(path)));
      normalizedChanges.forEach((change, index) => {
        const actualRevision = currentFiles[index].revision;
        if (actualRevision !== change.expectedRevision) {
          throw new VersionConflictError(change.expectedRevision, actualRevision);
        }
      });

      const transactionId = randomUUID();
      const workingDir = join(this.transactionDir, transactionId);
      const backupDir = join(workingDir, "backups");
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const entries: TransactionManifestEntry[] = [];

      try {
        for (const [index, change] of normalizedChanges.entries()) {
          const current = currentFiles[index];
          const backupFile = current.exists ? join("backups", `${index}.bin`) : undefined;
          if (backupFile && current.content !== undefined) {
            await replaceFileAtomic(join(workingDir, backupFile), current.content);
          }
          entries.push({
            path: change.path,
            existed: current.exists,
            backupFile,
            sensitive: change.sensitive,
          });
        }

        const manifest: TransactionManifest = {
          version: 1,
          id: transactionId,
          createdAt: new Date().toISOString(),
          entries,
        };
        await this.writeMetadata(join(workingDir, "manifest.json"), manifest);
      } catch (error) {
        // manifest 尚未 durable 前没有恢复入口，必须立即清掉可能含凭证的备份。
        await rm(workingDir, { recursive: true, force: true });
        throw error;
      }

      let attemptedEntries = 0;
      try {
        for (const change of normalizedChanges) {
          attemptedEntries += 1;
          if (change.nextContent === null) {
            await rm(change.path, { force: true });
          } else {
            await this.replaceFile(change.path, change.nextContent);
            await chmod(change.path, 0o600);
          }
        }
      } catch (commitError) {
        try {
          await rollbackEntries(this.rootDir, workingDir, entries.slice(0, attemptedEntries));
          await rm(workingDir, { recursive: true, force: true });
        } catch (rollbackError) {
          throw new DomainError("CONFIG_ROLLBACK_FAILED", "配置提交失败且无法完整回滚", {
            files: entries.slice(0, attemptedEntries).map(({ path }) => basename(path)),
          }, { cause: rollbackError });
        }
        throw new DomainError("CONFIG_COMMIT_FAILED", "配置提交失败，已恢复原配置", {
          files: entries.slice(0, attemptedEntries).map(({ path }) => basename(path)),
        }, { cause: commitError });
      }

      // durable commit marker 把“已完整提交但尚未清理”与“需要恢复”区分开。
      // marker 自身失败时必须在仍持有文件锁期间回滚，否则下次启动会误用旧备份覆盖后续写入。
      try {
        await this.writeMetadata(join(workingDir, "committed.json"), {
          version: 1,
          committedAt: new Date().toISOString(),
        });
      } catch (markerError) {
        try {
          await rollbackEntries(this.rootDir, workingDir, entries);
          await rm(workingDir, { recursive: true, force: true });
        } catch (rollbackError) {
          throw new DomainError("CONFIG_ROLLBACK_FAILED", "配置提交标记写入失败且无法完整回滚", {
            files: entries.map(({ path }) => basename(path)),
          }, { cause: new AggregateError([markerError, rollbackError]) });
        }
        throw new DomainError("CONFIG_COMMIT_FAILED", "配置提交标记写入失败，已恢复原配置", {
          files: entries.map(({ path }) => basename(path)),
        }, { cause: markerError });
      }
      await rm(workingDir, { recursive: true, force: true }).catch(() => {
        // committed marker 已 durable，残留目录会在下次启动清理，不能把已提交配置伪装成失败。
      });
    } finally {
      for (const release of releases.reverse()) {
        await release();
      }
    }
  }

  /**
   * 回滚所有仍有 manifest 的未完成事务。
   */
  async recover(): Promise<void> {
    await mkdir(this.transactionDir, { recursive: true, mode: 0o700 });
    const candidates = await readdir(this.transactionDir, { withFileTypes: true });
    for (const candidate of candidates) {
      if (!candidate.isDirectory()) {
        continue;
      }
      const workingDir = join(this.transactionDir, candidate.name);
      const manifestPath = join(workingDir, "manifest.json");
      let manifest: TransactionManifest;
      try {
        manifest = JSON.parse(await readFile(manifestPath, "utf8")) as TransactionManifest;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(candidate.name)) {
            await rm(workingDir, { recursive: true, force: true });
          }
          continue;
        }
        throw error;
      }

      try {
        await readFile(join(workingDir, "committed.json"));
        await rm(workingDir, { recursive: true, force: true });
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      await rollbackEntries(this.rootDir, workingDir, manifest.entries);

      await rm(workingDir, { recursive: true, force: true });
    }
  }
}

/** 按提交相反顺序恢复已触碰文件，避免关联文件暴露混合版本。 */
async function rollbackEntries(rootDir: string, workingDir: string, entries: TransactionManifestEntry[]): Promise<void> {
  for (const entry of [...entries].reverse()) {
    const targetPath = await resolveAllowedPath(rootDir, entry.path);
    if (!entry.existed) {
      await rm(targetPath, { force: true });
      continue;
    }
    if (!entry.backupFile) throw new Error("配置事务缺少恢复副本");
    const backup = await readFile(join(workingDir, entry.backupFile));
    await replaceFileAtomic(targetPath, backup);
  }
}

/**
 * 恢复指定目录中的所有未完成配置事务。
 *
 * @param options 数据路径与文件替换依赖
 */
export async function recoverPendingTransactions(options: ConfigTransactionOptions): Promise<void> {
  await new ConfigTransaction(options).recover();
}
