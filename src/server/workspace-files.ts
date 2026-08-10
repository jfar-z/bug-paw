import { lstat, mkdir, open, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mime from "mime";
import type { WorkspaceEntry, WorkspaceTextPreview } from "../shared/contracts";
import { sanitizeAttachmentName, normalizeWorkspacePath } from "./attachments";
import { AgentStore } from "./agents/agent-store";
import { SYSTEM_LIMITS } from "./core/limits";

const TEXT_PREVIEW_LIMIT_BYTES = 512 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".mdx", ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".xml", ".py", ".java", ".go", ".rs", ".sh", ".sql", ".log"]);

/** 工作区文件管理可稳定映射为 HTTP 响应的错误。 */
export class WorkspaceFileManagerError extends Error {
  /** 错误分类。 */
  readonly code: "INVALID_PATH" | "NOT_FOUND" | "CONFLICT" | "UNSAFE_LINK" | "TEXT_PREVIEW_UNAVAILABLE" | "WORKSPACE_SCAN_LIMIT";

  /**
   * 创建工作区文件管理错误。
   *
   * @param code 稳定错误分类
   * @param message 面向用户的错误说明
   */
  constructor(code: WorkspaceFileManagerError["code"], message: string) {
    super(message);
    this.name = "WorkspaceFileManagerError";
    this.code = code;
  }
}

/** 上传到指定工作目录的单个文件流。 */
export interface WorkspaceUpload {
  filename: string;
  mediaType: string;
  stream: Readable;
}

/** Agent 工作目录浏览和管理能力。 */
export interface WorkspaceFileManager {
  list(agentId: string, directory: string, includeHidden: boolean): Promise<WorkspaceEntry[]>;
  search(agentId: string, query: string, includeHidden: boolean): Promise<WorkspaceEntry[]>;
  listReferences(agentId: string): Promise<WorkspaceEntry[]>;
  readText(agentId: string, path: string): Promise<WorkspaceTextPreview>;
  /**
   * 安全读取当前 Agent 工作区内的一份文件，用于受限的服务端资料导入。
   *
   * @param agentId Agent 标识
   * @param path 工作区相对文件路径
   * @param maxBytes 允许读取的最大字节数
   */
  readFile(agentId: string, path: string, maxBytes: number): Promise<{ name: string; mediaType: string; content: Buffer }>;
  saveUploads(agentId: string, directory: string, uploads: Iterable<WorkspaceUpload> | AsyncIterable<WorkspaceUpload>): Promise<WorkspaceEntry[]>;
  createDirectory(agentId: string, directory: string, name: string): Promise<WorkspaceEntry>;
  rename(agentId: string, path: string, name: string): Promise<WorkspaceEntry>;
  move(agentId: string, path: string, targetDirectory: string, createTargetDirectory?: boolean): Promise<WorkspaceEntry>;
  remove(agentId: string, paths: string[]): Promise<void>;
}

/**
 * 创建只在单个 Agent cwd 内进行文件操作的管理服务。
 */
export function createWorkspaceFileManager(agents: AgentStore): WorkspaceFileManager {
  const workspaceFor = async (agentId: string) => realpath(await agents.resolveWorkspace(agentId));

  const resolveExisting = async (agentId: string, path: string) => {
    const workspace = await workspaceFor(agentId);
    const normalized = normalizeEntryPath(path);
    const candidate = resolve(workspace, normalized);
    if (!isWithin(workspace, candidate)) throw new WorkspaceFileManagerError("INVALID_PATH", "文件路径越出 Agent 工作目录");
    const actualPath = await realpath(candidate).catch((error) => {
      if (isMissing(error)) throw new WorkspaceFileManagerError("NOT_FOUND", "文件或目录不存在");
      throw error;
    });
    if (!isWithin(workspace, actualPath) || actualPath !== candidate) {
      throw new WorkspaceFileManagerError("UNSAFE_LINK", "文件路径包含不受支持的符号链接");
    }
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if (isMissing(error)) throw new WorkspaceFileManagerError("NOT_FOUND", "文件或目录不存在");
      throw error;
    }
    if (info.isSymbolicLink()) {
      const linked = await realpath(candidate).catch(() => undefined);
      if (!linked || !isWithin(workspace, linked)) throw new WorkspaceFileManagerError("UNSAFE_LINK", "文件链接越出 Agent 工作目录");
      throw new WorkspaceFileManagerError("UNSAFE_LINK", "暂不支持操作符号链接");
    }
    return { workspace, path: normalized, absolutePath: candidate, info };
  };

  const resolveDirectory = async (agentId: string, directory: string) => {
    const workspace = await workspaceFor(agentId);
    if (!directory) return { workspace, path: "", absolutePath: workspace };
    const resolved = await resolveExisting(agentId, directory);
    if (!resolved.info.isDirectory()) throw new WorkspaceFileManagerError("INVALID_PATH", "目标路径不是目录");
    return resolved;
  };

  const resolveOrCreateDirectory = async (agentId: string, directory: string, createTargetDirectory: boolean) => {
    try {
      return await resolveDirectory(agentId, directory);
    } catch (error) {
      if (!createTargetDirectory || !(error instanceof WorkspaceFileManagerError) || error.code !== "NOT_FOUND") throw error;
    }

    const workspace = await workspaceFor(agentId);
    const normalized = normalizeEntryPath(directory);
    let absolutePath = workspace;
    for (const segment of normalized.split("/")) {
      const candidate = join(absolutePath, segment);
      let info;
      try {
        info = await lstat(candidate);
      } catch (error) {
        if (!isMissing(error)) throw error;
        try {
          // 仅在用户确认后逐层创建，避免符号链接被递归创建操作穿透。
          await mkdir(candidate, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isExists(mkdirError)) throw mkdirError;
        }
        info = await lstat(candidate);
      }
      if (info.isSymbolicLink()) throw new WorkspaceFileManagerError("UNSAFE_LINK", "暂不支持操作符号链接");
      if (!info.isDirectory()) throw new WorkspaceFileManagerError("INVALID_PATH", "目标路径不是目录");
      absolutePath = candidate;
    }
    return { workspace, path: normalized, absolutePath, info: await lstat(absolutePath) };
  };

  const entryFrom = async (workspace: string, absolutePath: string, relativePath: string): Promise<WorkspaceEntry | undefined> => {
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink()) {
      const linked = await realpath(absolutePath).catch(() => undefined);
      if (!linked || !isWithin(workspace, linked)) return undefined;
      return undefined;
    }
    const kind = info.isDirectory() ? "directory" : info.isFile() ? "file" : undefined;
    if (!kind) return undefined;
    return {
      path: relativePath,
      name: basename(relativePath),
      kind,
      ...(kind === "file" ? { size: info.size, mediaType: mime.getType(absolutePath) ?? "application/octet-stream" } : {}),
      modifiedAt: info.mtime.toISOString(),
    };
  };

  const createScanGuard = () => {
    const deadline = Date.now() + SYSTEM_LIMITS.workspaceScanTimeoutMs;
    let entries = 0;
    return (depth: number, addedEntries: number) => {
      entries += addedEntries;
      if (depth > SYSTEM_LIMITS.workspaceDepth || entries > SYSTEM_LIMITS.workspaceEntries || Date.now() > deadline) {
        throw new WorkspaceFileManagerError("WORKSPACE_SCAN_LIMIT", "工作区扫描超过系统允许的范围");
      }
    };
  };

  const listDirectoryBounded = async (
    workspace: string,
    directoryPath: string,
    absoluteDirectory: string,
    includeHidden: boolean,
    depth: number,
    assertWithinLimits: (depth: number, addedEntries: number) => void,
  ): Promise<WorkspaceEntry[]> => {
    const results: WorkspaceEntry[] = [];
    const directory = await opendir(absoluteDirectory);
    for await (const item of directory) {
      if (!includeHidden && item.name.startsWith(".")) continue;
      // 在物化与 lstat 前计数，恶意超大目录不会先占满内存再触发上限。
      assertWithinLimits(depth, 1);
      const path = directoryPath ? `${directoryPath}/${item.name}` : item.name;
      const entry = await entryFrom(workspace, join(absoluteDirectory, item.name), path);
      if (entry) results.push(entry);
    }
    return results.sort(compareEntries);
  };

  return {
    async list(agentId, directory, includeHidden) {
      const target = await resolveDirectory(agentId, directory);
      return listDirectoryBounded(target.workspace, target.path, target.absolutePath, includeHidden, 0, createScanGuard());
    },

    async search(agentId, query, includeHidden) {
      const workspace = await workspaceFor(agentId);
      const normalizedQuery = query.trim().toLocaleLowerCase();
      if (!normalizedQuery) return [];
      const matches: WorkspaceEntry[] = [];
      const assertWithinLimits = createScanGuard();
      const visit = async (directoryPath: string, absoluteDirectory: string, depth: number): Promise<void> => {
        const directoryEntries = await listDirectoryBounded(workspace, directoryPath, absoluteDirectory, includeHidden, depth, assertWithinLimits);
        for (const entry of directoryEntries) {
          if (entry.kind === "directory") {
            await visit(entry.path, join(workspace, entry.path), depth + 1);
          } else if (entry.name.toLocaleLowerCase().includes(normalizedQuery)) {
            matches.push(entry);
          }
        }
      };
      await visit("", workspace, 0);
      return matches.sort(compareEntries);
    },

    async listReferences(agentId) {
      const workspace = await workspaceFor(agentId);
      const entries: WorkspaceEntry[] = [];
      const assertWithinLimits = createScanGuard();
      const visit = async (directoryPath: string, absoluteDirectory: string, depth: number): Promise<void> => {
        const directoryEntries = await listDirectoryBounded(workspace, directoryPath, absoluteDirectory, true, depth, assertWithinLimits);
        for (const entry of directoryEntries) {
          // .pi 保存 Pi 的会话与私有配置，不应出现在可引用的工作区资源中。
          if (entry.name === ".pi") {
            continue;
          }
          entries.push(entry);
          if (entry.kind === "directory") {
            await visit(entry.path, join(workspace, entry.path), depth + 1);
          }
        }
      };
      await visit("", workspace, 0);
      return entries.sort((left, right) => left.path.localeCompare(right.path, "zh-CN"));
    },

    async readText(agentId, path) {
      const target = await resolveExisting(agentId, path);
      if (!target.info.isFile()) throw new WorkspaceFileManagerError("TEXT_PREVIEW_UNAVAILABLE", "当前项目不是可预览的文本文件");
      const mediaType = mime.getType(target.absolutePath) ?? "application/octet-stream";
      if (!mediaType.startsWith("text/") && !TEXT_EXTENSIONS.has(extensionOf(target.path))) {
        throw new WorkspaceFileManagerError("TEXT_PREVIEW_UNAVAILABLE", "当前文件不支持文本预览");
      }
      const content = await readBounded(target.absolutePath, TEXT_PREVIEW_LIMIT_BYTES);
      try {
        return {
          path: target.path,
          content: decodeUtf8Prefix(content.content, content.truncated),
          truncated: content.truncated,
        };
      } catch {
        throw new WorkspaceFileManagerError("TEXT_PREVIEW_UNAVAILABLE", "文件不是 UTF-8 文本");
      }
    },

    async readFile(agentId, path, maxBytes) {
      const target = await resolveExisting(agentId, path);
      if (!target.info.isFile()) throw new WorkspaceFileManagerError("INVALID_PATH", "目标路径不是文件");
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || target.info.size > maxBytes) {
        throw new WorkspaceFileManagerError("INVALID_PATH", "资料不能超过允许的大小限制");
      }
      const content = await readBounded(target.absolutePath, maxBytes);
      if (content.truncated) throw new WorkspaceFileManagerError("INVALID_PATH", "资料不能超过允许的大小限制");
      return {
        name: basename(target.path),
        mediaType: mime.getType(target.absolutePath) ?? "application/octet-stream",
        content: content.content,
      };
    },

    async saveUploads(agentId, directory, uploads) {
      const target = await resolveDirectory(agentId, directory);
      const saved: WorkspaceEntry[] = [];
      const createdPaths: string[] = [];
      try {
        for await (const upload of uploads) {
          const name = sanitizeAttachmentName(upload.filename);
          const absolutePath = join(target.absolutePath, name);
          if (!isWithin(target.workspace, absolutePath)) throw new WorkspaceFileManagerError("INVALID_PATH", "上传路径越出 Agent 工作目录");
          let handle;
          try {
            handle = await open(absolutePath, "wx", 0o600);
            // 当前文件一创建就纳入补偿，客户端中断或 pipeline 失败也不能留下半文件。
            createdPaths.push(absolutePath);
          } catch (error) {
            if (isExists(error)) throw new WorkspaceFileManagerError("CONFLICT", "目标目录已存在同名文件");
            throw error;
          }
          await pipeline(upload.stream, handle.createWriteStream());
          const fileInfo = await stat(absolutePath);
          saved.push({ path: joinPath(target.path, name), name, kind: "file", size: fileInfo.size, mediaType: upload.mediaType || mime.getType(absolutePath) || "application/octet-stream", modifiedAt: fileInfo.mtime.toISOString() });
        }
        return saved;
      } catch (error) {
        await Promise.all(createdPaths.map((path) => rm(path, { force: true })));
        throw error;
      }
    },

    async createDirectory(agentId, directory, name) {
      const target = await resolveDirectory(agentId, directory);
      const safeName = normalizeSingleName(name);
      const absolutePath = join(target.absolutePath, safeName);
      try {
        await mkdir(absolutePath, { mode: 0o700 });
      } catch (error) {
        if (isExists(error)) throw new WorkspaceFileManagerError("CONFLICT", "目标目录已存在同名项目");
        throw error;
      }
      return (await entryFrom(target.workspace, absolutePath, joinPath(target.path, safeName)))!;
    },

    async rename(agentId, path, name) {
      const source = await resolveExisting(agentId, path);
      const targetPath = join(resolve(source.absolutePath, ".."), normalizeSingleName(name));
      if (!isWithin(source.workspace, targetPath)) throw new WorkspaceFileManagerError("INVALID_PATH", "重命名路径越出 Agent 工作目录");
      try {
        await lstat(targetPath);
        throw new WorkspaceFileManagerError("CONFLICT", "目标目录已存在同名项目");
      } catch (error) {
        if (!(error instanceof WorkspaceFileManagerError) && !isMissing(error)) throw error;
        if (error instanceof WorkspaceFileManagerError) throw error;
      }
      await rename(source.absolutePath, targetPath);
      return (await entryFrom(source.workspace, targetPath, joinPath(parentPath(source.path), basename(targetPath))))!;
    },

    async move(agentId, path, targetDirectory, createTargetDirectory = false) {
      const source = await resolveExisting(agentId, path);
      const normalizedTargetDirectory = targetDirectory ? normalizeEntryPath(targetDirectory) : "";
      if (source.info.isDirectory() && (normalizedTargetDirectory === source.path || normalizedTargetDirectory.startsWith(`${source.path}/`))) {
        throw new WorkspaceFileManagerError("INVALID_PATH", "不能移动到当前目录或其子目录");
      }
      const target = await resolveOrCreateDirectory(agentId, normalizedTargetDirectory, createTargetDirectory);
      const targetPath = join(target.absolutePath, basename(source.path));
      try {
        await lstat(targetPath);
        throw new WorkspaceFileManagerError("CONFLICT", "目标目录已存在同名项目");
      } catch (error) {
        if (!(error instanceof WorkspaceFileManagerError) && !isMissing(error)) throw error;
        if (error instanceof WorkspaceFileManagerError) throw error;
      }
      await rename(source.absolutePath, targetPath);
      return (await entryFrom(source.workspace, targetPath, joinPath(target.path, basename(source.path))))!;
    },

    async remove(agentId, paths) {
      const uniquePaths = [...new Set(paths.map(normalizeEntryPath))]
        .filter((path, _index, all) => !all.some((candidate) => candidate !== path && path.startsWith(`${candidate}/`)));
      if (uniquePaths.length === 0) throw new WorkspaceFileManagerError("INVALID_PATH", "至少选择一个文件或目录");
      const resolved = await Promise.all(uniquePaths.map((path) => resolveExisting(agentId, path)));
      await Promise.all(resolved.map((item) => rm(item.absolutePath, { recursive: item.info.isDirectory(), force: true })));
    },
  };
}

/** 只读取上限加一个字节，用实际读取结果抵御文件增长竞态与超大文件内存峰值。 */
async function readBounded(path: string, limit: number): Promise<{ content: Buffer; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(limit + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { content: buffer.subarray(0, Math.min(offset, limit)), truncated: offset > limit };
  } finally {
    await handle.close();
  }
}

/** 截断点落在 UTF-8 多字节字符中间时最多回退三个字节，其他非法编码仍拒绝预览。 */
function decodeUtf8Prefix(content: Buffer, truncated: boolean): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const attempts = truncated ? 4 : 1;
  let lastError: unknown;
  for (let trim = 0; trim < attempts && trim <= content.byteLength; trim += 1) {
    try {
      return decoder.decode(trim === 0 ? content : content.subarray(0, content.byteLength - trim));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function normalizeEntryPath(path: string): string {
  try {
    return normalizeWorkspacePath(path);
  } catch {
    throw new WorkspaceFileManagerError("INVALID_PATH", "文件路径无效");
  }
}

function normalizeSingleName(name: string): string {
  const value = name.trim();
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new WorkspaceFileManagerError("INVALID_PATH", "名称必须是单层文件或目录名称");
  }
  return value;
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function compareEntries(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return Number(right.kind === "directory") - Number(left.kind === "directory") || left.name.localeCompare(right.name, "zh-CN");
}

function extensionOf(path: string): string {
  const index = path.lastIndexOf(".");
  return index < 0 ? "" : path.slice(index).toLowerCase();
}

function joinPath(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isExists(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
