import { randomUUID } from "node:crypto";
import { mkdir, open, opendir, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { AigcPublicDirectoryEntry, AigcPublicFileRecord } from "../../shared/aigc-contracts";
import { MAX_INPUT_ASSET_BYTES, normalizeMediaType, sanitizeFileName, validAssetId } from "./aigc-asset-service";
import { readJson, writeJsonAtomic } from "../storage";

const TEXT_PREVIEW_LIMIT_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "mdx", "json", "yaml", "yml", "toml", "ini", "csv", "css", "html", "xml", "js", "ts", "tsx", "jsx", "py", "java", "go", "rs", "sh", "sql", "log"]);

interface StoredPublicDirectory {
  path: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredAigcPublicFiles {
  files: AigcPublicFileRecord[];
  directories?: StoredPublicDirectory[];
}

export interface AigcPublicUpload {
  filename: string;
  mediaType: string;
  stream: Readable;
}

/** 公开目录操作可稳定映射到 HTTP 的错误。 */
export class AigcPublicDirectoryError extends Error {
  constructor(readonly code: "INVALID_PATH" | "NOT_FOUND" | "CONFLICT" | "TEXT_PREVIEW_UNAVAILABLE", message: string) {
    super(message);
    this.name = "AigcPublicDirectoryError";
  }
}

/** 管理无需登录即可凭稳定 URL 访问、但仅登录用户可列出和整理的 AIGC 公共文件。 */
export class AigcPublicFileService {
  private readonly fileDir: string;
  private readonly indexFile: string;
  private readonly files = new Map<string, AigcPublicFileRecord>();
  private readonly directories = new Map<string, StoredPublicDirectory>();
  private readonly ready: Promise<void>;
  private mutationTail = Promise.resolve();

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
    return [...this.files.values()].map(copyPublicFile).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  /** 读取单个公共文件记录。 */
  async get(id: string): Promise<AigcPublicFileRecord | undefined> {
    await this.ready;
    const record = this.files.get(id);
    return record ? copyPublicFile(record) : undefined;
  }

  /** 列出逻辑目录的直接子项。 */
  async listEntries(directory = ""): Promise<AigcPublicDirectoryEntry[]> {
    await this.ready;
    const normalized = normalizeDirectory(directory);
    this.assertDirectoryExists(normalized);
    const directoryEntries = [...this.directories.values()]
      .filter((item) => parentPath(item.path) === normalized)
      .map(toDirectoryEntry);
    const fileEntries = [...this.files.values()]
      .filter((item) => item.directory === normalized)
      .map(toFileEntry);
    return [...directoryEntries, ...fileEntries].sort(compareEntries);
  }

  /** 按文件名搜索整个公开目录。 */
  async searchEntries(query: string): Promise<AigcPublicDirectoryEntry[]> {
    await this.ready;
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return [...this.files.values()]
      .filter((item) => item.name.toLocaleLowerCase().includes(normalized))
      .map(toFileEntry)
      .sort(compareEntries);
  }

  /** 保存单个上传流并写入公共文件索引。 */
  async save(stream: Readable, fileName: string, mediaType: string, directory = ""): Promise<AigcPublicFileRecord> {
    const saved = await this.saveMany([{ filename: fileName, mediaType, stream }], directory);
    return saved[0];
  }

  /** 原子保存一批上传文件；任一文件失败时清理本批全部实体。 */
  async saveMany(uploads: Iterable<AigcPublicUpload> | AsyncIterable<AigcPublicUpload>, directory = ""): Promise<AigcPublicFileRecord[]> {
    return this.mutate(async () => {
      const normalizedDirectory = normalizeDirectory(directory);
      this.assertDirectoryExists(normalizedDirectory);
      await mkdir(this.fileDir, { recursive: true, mode: 0o700 });
      const created: AigcPublicFileRecord[] = [];
      const createdIds: string[] = [];
      try {
        for await (const upload of uploads) {
          const name = sanitizePublicName(upload.filename);
          this.assertAvailable(joinPath(normalizedDirectory, name));
          const id = randomUUID();
          const target = join(this.fileDir, id);
          await writeStream(upload.stream, target);
          createdIds.push(id);
          const fileStat = await stat(target);
          if (fileStat.size > MAX_INPUT_ASSET_BYTES) throw new AigcPublicDirectoryError("INVALID_PATH", "AIGC 公共文件不能超过 200 MiB");
          const record: AigcPublicFileRecord = {
            id,
            name,
            directory: normalizedDirectory,
            mediaType: normalizeMediaType(upload.mediaType, name),
            size: fileStat.size,
            createdAt: new Date().toISOString(),
          };
          this.files.set(id, record);
          created.push(record);
        }
        await this.persist();
        return created.map(copyPublicFile);
      } catch (error) {
        for (const record of created) this.files.delete(record.id);
        await Promise.all(createdIds.map((id) => rm(join(this.fileDir, id), { force: true })));
        throw error;
      }
    });
  }

  /** 新建逻辑目录。 */
  async createDirectory(directory: string, name: string): Promise<AigcPublicDirectoryEntry> {
    return this.mutate(async () => {
      const parent = normalizeDirectory(directory);
      this.assertDirectoryExists(parent);
      const path = joinPath(parent, sanitizePublicName(name));
      this.assertAvailable(path);
      const now = new Date().toISOString();
      const record = { path, createdAt: now, updatedAt: now };
      this.directories.set(path, record);
      try {
        await this.persist();
        return toDirectoryEntry(record);
      } catch (error) {
        this.directories.delete(path);
        throw error;
      }
    });
  }

  /** 重命名公开文件或目录，不改变文件稳定 ID 和公开 URL。 */
  async renameEntry(path: string, name: string): Promise<AigcPublicDirectoryEntry> {
    return this.moveOrRename(path, parentPath(normalizeEntryPath(path)), sanitizePublicName(name));
  }

  /** 移动公开文件或目录，必要时可在用户确认后创建目标目录。 */
  async moveEntry(path: string, targetDirectory: string, createTargetDirectory = false): Promise<AigcPublicDirectoryEntry> {
    const normalizedPath = normalizeEntryPath(path);
    const target = normalizeDirectory(targetDirectory);
    return this.mutate(async () => {
      const filesBefore = cloneFileMap(this.files);
      const directoriesBefore = cloneDirectoryMap(this.directories);
      try {
        if (!this.directoryExists(target)) {
          if (!createTargetDirectory) throw new AigcPublicDirectoryError("NOT_FOUND", "目标目录不存在");
          await this.ensureDirectories(target);
        }
        if (this.directories.has(normalizedPath) && (target === normalizedPath || target.startsWith(`${normalizedPath}/`))) {
          throw new AigcPublicDirectoryError("INVALID_PATH", "不能移动到当前目录或其子目录");
        }
        return await this.applyMove(normalizedPath, target, basename(normalizedPath));
      } catch (error) {
        restoreMap(this.files, filesBefore);
        restoreMap(this.directories, directoriesBefore);
        throw error;
      }
    });
  }

  /** 删除所选文件或目录及其子项。 */
  async removeEntries(paths: string[]): Promise<void> {
    await this.mutate(async () => {
      const normalized = [...new Set(paths.map(normalizeEntryPath))]
        .filter((path, _index, all) => !all.some((candidate) => candidate !== path && path.startsWith(`${candidate}/`)));
      if (!normalized.length) throw new AigcPublicDirectoryError("INVALID_PATH", "至少选择一个文件或目录");
      for (const path of normalized) this.assertEntryExists(path);
      const filesBefore = cloneFileMap(this.files);
      const directoriesBefore = cloneDirectoryMap(this.directories);
      const removedIds: string[] = [];
      for (const path of normalized) {
        for (const [id, file] of this.files) {
          const filePath = publicFilePath(file);
          if (filePath === path || filePath.startsWith(`${path}/`)) {
            removedIds.push(id);
            this.files.delete(id);
          }
        }
        for (const directoryPath of [...this.directories.keys()]) {
          if (directoryPath === path || directoryPath.startsWith(`${path}/`)) this.directories.delete(directoryPath);
        }
      }
      try {
        await this.persist();
      } catch (error) {
        restoreMap(this.files, filesBefore);
        restoreMap(this.directories, directoriesBefore);
        throw error;
      }
      // 索引提交后文件已不可发现；物理清理失败不应诱导客户端重试同一删除。
      await Promise.allSettled(removedIds.map((id) => rm(join(this.fileDir, id), { force: true })));
    });
  }

  /** 读取公开目录中的 UTF-8 文本预览。 */
  async readText(path: string): Promise<{ path: string; content: string; truncated: boolean }> {
    await this.ready;
    const record = this.fileByPath(normalizeEntryPath(path));
    if (!record) throw new AigcPublicDirectoryError("NOT_FOUND", "公开文件不存在");
    const extension = record.name.split(".").at(-1)?.toLowerCase() ?? "";
    if (!record.mediaType.startsWith("text/") && !TEXT_EXTENSIONS.has(extension)) {
      throw new AigcPublicDirectoryError("TEXT_PREVIEW_UNAVAILABLE", "当前文件不支持文本预览");
    }
    const source = await this.resolveExistingPath(record.id);
    if (!source) throw new AigcPublicDirectoryError("NOT_FOUND", "公开文件不存在");
    const handle = await open(source, "r");
    try {
      const buffer = Buffer.allocUnsafe(TEXT_PREVIEW_LIMIT_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const truncated = bytesRead > TEXT_PREVIEW_LIMIT_BYTES;
      try {
        return { path, content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, Math.min(bytesRead, TEXT_PREVIEW_LIMIT_BYTES))), truncated };
      } catch {
        throw new AigcPublicDirectoryError("TEXT_PREVIEW_UNAVAILABLE", "文件不是 UTF-8 文本");
      }
    } finally {
      await handle.close();
    }
  }

  /** 解析公共文件实体路径，禁止越界。 */
  async resolvePath(id: string): Promise<string | undefined> {
    await this.ready;
    return this.resolveExistingPath(id);
  }

  /** 兼容旧接口按稳定 ID 删除单个公共文件。 */
  async remove(id: string): Promise<boolean> {
    await this.ready;
    const record = this.files.get(id);
    if (!record) return false;
    await this.removeEntries([publicFilePath(record)]);
    return true;
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

  /** 加载索引、兼容旧版根目录记录，并清理未被索引引用的历史实体。 */
  private async load(): Promise<void> {
    const value = await readJson<StoredAigcPublicFiles>(this.indexFile);
    if (isStoredAigcPublicFiles(value)) {
      for (const directory of value.directories ?? []) {
        try {
          const path = normalizeDirectory(directory.path);
          if (path) this.directories.set(path, { ...directory, path });
        } catch {
          // 损坏的单条目录元数据不能扩大公开文件边界。
        }
      }
      for (const stored of value.files) {
        const record = normalizeStoredFile(stored);
        if (record && await this.resolveExistingPath(record.id)) {
          this.files.set(record.id, record);
          this.ensureDirectoryMetadata(record.directory, record.createdAt);
        }
      }
    }
    await this.cleanupOrphans();
  }

  /** 原子保存当前逻辑目录和文件索引。 */
  private async persist(): Promise<void> {
    await writeJsonAtomic(this.indexFile, {
      files: [...this.files.values()].map(copyPublicFile),
      directories: [...this.directories.values()].map((item) => ({ ...item })),
    });
  }

  /** 串行化多文件与索引变更，避免并发请求互相覆盖。 */
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(async () => {
      await this.ready;
      return operation();
    });
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async moveOrRename(path: string, targetDirectory: string, targetName: string): Promise<AigcPublicDirectoryEntry> {
    return this.mutate(() => this.applyMove(normalizeEntryPath(path), normalizeDirectory(targetDirectory), targetName));
  }

  private async applyMove(path: string, targetDirectory: string, targetName: string): Promise<AigcPublicDirectoryEntry> {
    this.assertDirectoryExists(targetDirectory);
    this.assertEntryExists(path);
    const targetPath = joinPath(targetDirectory, targetName);
    if (targetPath !== path) this.assertAvailable(targetPath);
    const filesBefore = cloneFileMap(this.files);
    const directoriesBefore = cloneDirectoryMap(this.directories);
    const now = new Date().toISOString();
    const file = this.fileByPath(path);
    if (file) {
      file.name = targetName;
      file.directory = targetDirectory;
    } else {
      const directory = this.directories.get(path)!;
      this.directories.delete(path);
      this.directories.set(targetPath, { ...directory, path: targetPath, updatedAt: now });
      for (const [childPath, child] of [...this.directories]) {
        if (!childPath.startsWith(`${path}/`)) continue;
        const nextPath = `${targetPath}${childPath.slice(path.length)}`;
        this.directories.delete(childPath);
        this.directories.set(nextPath, { ...child, path: nextPath, updatedAt: now });
      }
      for (const childFile of this.files.values()) {
        if (childFile.directory === path || childFile.directory.startsWith(`${path}/`)) {
          childFile.directory = `${targetPath}${childFile.directory.slice(path.length)}`;
        }
      }
    }
    try {
      await this.persist();
    } catch (error) {
      restoreMap(this.files, filesBefore);
      restoreMap(this.directories, directoriesBefore);
      throw error;
    }
    return file ? toFileEntry(file) : toDirectoryEntry(this.directories.get(targetPath)!);
  }

  private async ensureDirectories(path: string): Promise<void> {
    let current = "";
    const now = new Date().toISOString();
    for (const segment of path.split("/").filter(Boolean)) {
      current = joinPath(current, segment);
      if (this.fileByPath(current)) throw new AigcPublicDirectoryError("CONFLICT", "目标路径已存在同名文件");
      if (!this.directories.has(current)) this.directories.set(current, { path: current, createdAt: now, updatedAt: now });
    }
  }

  private ensureDirectoryMetadata(path: string, timestamp: string): void {
    let current = "";
    for (const segment of path.split("/").filter(Boolean)) {
      current = joinPath(current, segment);
      if (!this.directories.has(current)) this.directories.set(current, { path: current, createdAt: timestamp, updatedAt: timestamp });
    }
  }

  private directoryExists(path: string): boolean {
    return path === "" || this.directories.has(path);
  }

  private assertDirectoryExists(path: string): void {
    if (!this.directoryExists(path)) throw new AigcPublicDirectoryError("NOT_FOUND", "目标目录不存在");
  }

  private assertEntryExists(path: string): void {
    if (!this.directories.has(path) && !this.fileByPath(path)) throw new AigcPublicDirectoryError("NOT_FOUND", "公开文件或目录不存在");
  }

  private assertAvailable(path: string): void {
    if (this.directories.has(path) || this.fileByPath(path)) throw new AigcPublicDirectoryError("CONFLICT", "目标目录已存在同名项目");
  }

  private fileByPath(path: string): AigcPublicFileRecord | undefined {
    return [...this.files.values()].find((file) => publicFilePath(file) === path);
  }

  private async cleanupOrphans(): Promise<void> {
    const referenced = new Set(this.files.keys());
    let directory;
    try {
      directory = await opendir(this.fileDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for await (const entry of directory) {
      if (entry.isFile() && validAssetId(entry.name) && !referenced.has(entry.name)) await rm(join(this.fileDir, entry.name), { force: true });
    }
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

function normalizeStoredFile(record: AigcPublicFileRecord): AigcPublicFileRecord | undefined {
  if (!validAssetId(record.id) || typeof record.name !== "string" || typeof record.mediaType !== "string" || typeof record.size !== "number" || typeof record.createdAt !== "string") return undefined;
  try {
    return { ...record, name: sanitizePublicName(record.name), directory: normalizeDirectory(typeof record.directory === "string" ? record.directory : "") };
  } catch {
    return undefined;
  }
}

function sanitizePublicName(input: string): string {
  const name = sanitizeFileName(input);
  if (!name || name === "." || name === "..") throw new AigcPublicDirectoryError("INVALID_PATH", "文件或目录名称无效");
  return name;
}

function normalizeDirectory(input: string): string {
  if (input.includes("\0")) throw new AigcPublicDirectoryError("INVALID_PATH", "目录路径无效");
  const segments = input.replaceAll("\\", "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) throw new AigcPublicDirectoryError("INVALID_PATH", "目录路径无效");
  return segments.map(sanitizePublicName).join("/");
}

function normalizeEntryPath(input: string): string {
  const normalized = normalizeDirectory(input);
  if (!normalized) throw new AigcPublicDirectoryError("INVALID_PATH", "文件或目录路径无效");
  return normalized;
}

function publicFilePath(file: AigcPublicFileRecord): string {
  return joinPath(file.directory, file.name);
}

function joinPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function toDirectoryEntry(record: StoredPublicDirectory): AigcPublicDirectoryEntry {
  return { path: record.path, name: basename(record.path), kind: "directory", modifiedAt: record.updatedAt };
}

function toFileEntry(record: AigcPublicFileRecord): AigcPublicDirectoryEntry {
  return { path: publicFilePath(record), name: record.name, kind: "file", modifiedAt: record.createdAt, id: record.id, mediaType: record.mediaType, size: record.size };
}

function compareEntries(left: AigcPublicDirectoryEntry, right: AigcPublicDirectoryEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, "zh-CN");
}

function copyPublicFile(record: AigcPublicFileRecord): AigcPublicFileRecord {
  return { ...record };
}

function cloneFileMap(source: Map<string, AigcPublicFileRecord>): Map<string, AigcPublicFileRecord> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function cloneDirectoryMap(source: Map<string, StoredPublicDirectory>): Map<string, StoredPublicDirectory> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function restoreMap<T>(target: Map<string, T>, snapshot: Map<string, T>): void {
  target.clear();
  for (const [key, value] of snapshot) target.set(key, value);
}

function isStoredAigcPublicFiles(value: unknown): value is StoredAigcPublicFiles {
  return typeof value === "object" && value !== null && "files" in value && Array.isArray((value as StoredAigcPublicFiles).files);
}
