import { randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AigcPublicFileRecord } from "../../shared/aigc-contracts";
import { MAX_INPUT_ASSET_BYTES, normalizeMediaType, sanitizeFileName, validAssetId } from "./aigc-asset-service";
import { readJson, writeJsonAtomic } from "../storage";

interface StoredAigcPublicFiles {
  files: AigcPublicFileRecord[];
}

/** 管理无需登录即可直接访问的 AIGC 公共输入文件。 */
export class AigcPublicFileService {
  private readonly fileDir: string;
  private readonly indexFile: string;
  private readonly files = new Map<string, AigcPublicFileRecord>();
  private readonly ready: Promise<void>;

  /**
   * @param rootDir 公共文件存储根目录
   */
  constructor(rootDir: string) {
    this.fileDir = join(rootDir, "files");
    this.indexFile = join(rootDir, "index.json");
    this.ready = this.load();
  }

  /** 列出全部公共文件，按创建时间倒序。 */
  async list(): Promise<AigcPublicFileRecord[]> {
    await this.ready;
    return [...this.files.values()]
      .map(copyPublicFile)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 读取单个公共文件记录。 */
  async get(id: string): Promise<AigcPublicFileRecord | undefined> {
    await this.ready;
    const record = this.files.get(id);
    return record ? copyPublicFile(record) : undefined;
  }

  /** 保存上传流并写入公共文件索引。 */
  async save(stream: Readable, fileName: string, mediaType: string): Promise<AigcPublicFileRecord> {
    await this.ready;
    const id = randomUUID();
    const safeName = sanitizeFileName(fileName);
    const target = join(this.fileDir, id);
    await mkdir(this.fileDir, { recursive: true, mode: 0o700 });
    await writeStream(stream, target);
    try {
      const fileStat = await stat(target);
      if (fileStat.size > MAX_INPUT_ASSET_BYTES) {
        await rm(target, { force: true });
        throw new TypeError("AIGC 公共文件不能超过 200 MiB");
      }
      const record: AigcPublicFileRecord = {
        id,
        name: safeName,
        mediaType: normalizeMediaType(mediaType, safeName),
        size: fileStat.size,
        createdAt: new Date().toISOString(),
      };
      this.files.set(id, record);
      await this.persist();
      return copyPublicFile(record);
    } catch (error) {
      this.files.delete(id);
      await rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 解析公共文件路径，禁止越界。 */
  async resolvePath(id: string): Promise<string | undefined> {
    await this.ready;
    return this.resolveExistingPath(id);
  }

  /** 在索引加载阶段直接解析文件，不等待 ready，避免自引用死锁。 */
  private async resolveExistingPath(id: string): Promise<string | undefined> {
    if (!validAssetId(id)) return undefined;
    const directory = resolve(this.fileDir);
    const target = resolve(directory, id);
    if (target === directory || !target.startsWith(`${directory}${sep}`)) return undefined;
    try {
      const fileStat = await stat(target);
      return fileStat.isFile() ? target : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** 删除公共文件并同步索引。 */
  async remove(id: string): Promise<boolean> {
    await this.ready;
    if (!validAssetId(id) || !this.files.has(id)) return false;
    await rm(join(this.fileDir, id), { force: true });
    this.files.delete(id);
    await this.persist();
    return true;
  }

  /** 加载索引并过滤已经丢失的文件。 */
  private async load(): Promise<void> {
    const value = await readJson<StoredAigcPublicFiles>(this.indexFile);
    if (!isStoredAigcPublicFiles(value)) return;
    for (const record of value.files) {
      if (await this.fileExists(record.id)) this.files.set(record.id, copyPublicFile(record));
    }
  }

  /** 原子保存公共文件索引。 */
  private async persist(): Promise<void> {
    await writeJsonAtomic(this.indexFile, {
      files: [...this.files.values()].map(copyPublicFile),
    });
  }

  /** 判断文件是否仍存在于公共目录。 */
  private async fileExists(id: string): Promise<boolean> {
    return await this.resolveExistingPath(id) !== undefined;
  }
}

/** 将上传流写入目标文件，失败时清理残留。 */
async function writeStream(stream: Readable, target: string): Promise<void> {
  const handle = await open(target, "wx", 0o600);
  try {
    await pipeline(stream, handle.createWriteStream());
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(target, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 复制公共文件记录，避免调用方修改内部状态。 */
function copyPublicFile(record: AigcPublicFileRecord): AigcPublicFileRecord {
  return { ...record };
}

/** 校验持久化索引结构。 */
function isStoredAigcPublicFiles(value: unknown): value is StoredAigcPublicFiles {
  if (typeof value !== "object" || value === null || !("files" in value)) return false;
  const files = (value as StoredAigcPublicFiles).files;
  return Array.isArray(files)
    && files.every((file) => typeof file.id === "string"
      && typeof file.name === "string"
      && typeof file.mediaType === "string"
      && typeof file.size === "number"
      && typeof file.createdAt === "string");
}
