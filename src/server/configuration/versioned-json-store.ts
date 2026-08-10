import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import { writeJsonAtomic } from "../storage";

/**
 * 带原始文件版本的 JSON 文档。
 */
export interface VersionedDocument<T> {
  /**
   * 目标文件当前是否存在。
   */
  exists: boolean;
  /**
   * 基于原始文件字节计算的版本；缺失文件使用固定哨兵版本。
   */
  revision: string;
  /**
   * 文件存在且 JSON 合法时解析出的值。
   */
  value?: T;
}

/**
 * 提供乐观并发控制的 JSON 文件存储。
 */
export interface VersionedJsonStore<T> {
  /**
   * 读取当前文档及其版本。
   */
  read(): Promise<VersionedDocument<T>>;
  /**
   * 在可选版本匹配时原子写入文档。
   *
   * @param value 要写入的 JSON 值
   * @param expectedRevision 调用方最近读取到的版本
   */
  write(value: T, expectedRevision?: string): Promise<VersionedDocument<T>>;
  /**
   * 在版本匹配时删除文档。
   *
   * @param expectedRevision 调用方最近读取到的版本
   */
  remove(expectedRevision: string): Promise<void>;
}

/**
 * 表示目标文件已被其他写入者修改。
 */
export class VersionConflictError extends Error {
  /**
   * 调用方提交的旧版本。
   */
  readonly expectedRevision: string;
  /**
   * 锁内重新读取到的当前版本。
   */
  readonly actualRevision: string;

  /**
   * 创建版本冲突错误。
   *
   * @param expectedRevision 调用方提交的版本
   * @param actualRevision 文件当前版本
   */
  constructor(expectedRevision: string, actualRevision: string) {
    super("配置文件已被其他操作修改");
    this.name = "VersionConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

/**
 * 缺失文件使用独立哨兵，避免与零字节文件共享版本。
 */
const MISSING_REVISION = createHash("sha256").update("pi-agent:missing-file", "utf8").digest("hex");

interface RawVersionedFile {
  /**
   * 文件是否存在。
   */
  exists: boolean;
  /**
   * 原始文件内容。
   */
  content?: Buffer;
  /**
   * 当前版本。
   */
  revision: string;
}

/**
 * 读取文件原始字节，保证版本不受 JSON 重新序列化影响。
 *
 * @param filePath JSON 文件路径
 */
async function readRawVersion(filePath: string): Promise<RawVersionedFile> {
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
 * 读取任意文件的原始字节版本，不要求其内容为 JSON。
 *
 * @param filePath 目标文件路径
 */
export async function getFileRevision(filePath: string): Promise<string> {
  return (await readRawVersion(filePath)).revision;
}

/**
 * 在同目录稳定锁目标上执行文件变更。
 *
 * 锁目标不会随目标文件从缺失变为存在而改变，避免首次创建与后续更新
 * 分别持有不同锁而并发进入临界区。
 *
 * @param filePath JSON 文件路径
 * @param operation 锁内操作
 */
async function withStableLock<Result>(filePath: string, operation: () => Promise<Result>): Promise<Result> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockTarget = join(directory, `.${basename(filePath)}.lock-target`);
  const release = await lockfile.lock(lockTarget, {
    realpath: false,
    retries: {
      retries: 20,
      factor: 1.2,
      minTimeout: 5,
      maxTimeout: 50,
    },
  });

  try {
    return await operation();
  } finally {
    await release();
  }
}

/**
 * 校验锁内读取到的版本与调用方版本一致。
 *
 * @param expectedRevision 调用方提交的版本
 * @param actualRevision 当前文件版本
 */
function assertRevision(expectedRevision: string | undefined, actualRevision: string): void {
  if (expectedRevision !== undefined && expectedRevision !== actualRevision) {
    throw new VersionConflictError(expectedRevision, actualRevision);
  }
}

/**
 * 为指定 JSON 文件创建版本化存储。
 *
 * @param filePath JSON 文件路径
 */
export function createVersionedJsonStore<T>(filePath: string): VersionedJsonStore<T> {
  return {
    async read(): Promise<VersionedDocument<T>> {
      const current = await readRawVersion(filePath);
      if (!current.exists || current.content === undefined) {
        return { exists: false, revision: current.revision };
      }

      return {
        exists: true,
        revision: current.revision,
        value: JSON.parse(current.content.toString("utf8")) as T,
      };
    },

    async write(value: T, expectedRevision?: string): Promise<VersionedDocument<T>> {
      return withStableLock(filePath, async () => {
        const current = await readRawVersion(filePath);
        assertRevision(expectedRevision, current.revision);
        await writeJsonAtomic(filePath, value);

        const written = await readRawVersion(filePath);
        return {
          exists: true,
          revision: written.revision,
          value,
        };
      });
    },

    async remove(expectedRevision: string): Promise<void> {
      await withStableLock(filePath, async () => {
        const current = await readRawVersion(filePath);
        assertRevision(expectedRevision, current.revision);
        await rm(filePath, { force: true });
      });
    },
  };
}
