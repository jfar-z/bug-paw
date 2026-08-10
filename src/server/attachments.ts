import { createReadStream } from "node:fs";
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import mime from "mime";
import type { DataPaths } from "./paths";
import { AgentStore } from "./agents/agent-store";

export const DEFAULT_AGENT_ID = "default";
export const DEFAULT_UPLOAD_LIMITS = {
  maxFiles: 5,
  maxFileSize: 100 * 1024 * 1024,
} as const;

export interface UploadLimits {
  maxFiles: number;
  maxFileSize: number;
}

export interface WorkspaceFileInfo {
  path: string;
  name: string;
  mediaType: string;
  size: number;
  modifiedAt: string;
  absolutePath: string;
}

export type PublicWorkspaceFile = Omit<WorkspaceFileInfo, "absolutePath">;

export interface WorkspaceFileService {
  saveUpload(agentId: string, filename: string, mediaType: string, stream: Readable): Promise<WorkspaceFileInfo>;
  resolve(agentId: string, relativePath: string): Promise<WorkspaceFileInfo | undefined>;
  remove(agentId: string, relativePath: string): Promise<void>;
}

/**
 * 创建以 Agent cwd 为安全边界的通用文件服务。
 */
export function createWorkspaceFileService(paths: DataPaths, agentStore: AgentStore = new AgentStore(paths)): WorkspaceFileService {
  return {
    async saveUpload(agentId, filename, mediaType, stream) {
      const workspace = await agentStore.resolveWorkspace(agentId);
      await mkdir(resolve(workspace, "attachments"), { recursive: true, mode: 0o700 });
      const workspaceRealPath = await realpath(workspace);
      const attachmentRealPath = await realpath(resolve(workspace, "attachments"));
      if (!isWithin(workspaceRealPath, attachmentRealPath)) {
        throw new Error("附件目录已越出 Agent 工作目录");
      }

      const safeName = sanitizeAttachmentName(filename);
      let attempt = 0;
      let absolutePath = "";
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      while (!handle) {
        const name = candidateName(safeName, attempt);
        absolutePath = resolve(attachmentRealPath, name);
        try {
          handle = await open(absolutePath, "wx", 0o600);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
          attempt += 1;
        }
      }

      try {
        await pipeline(stream, handle.createWriteStream());
        const fileStat = await stat(absolutePath);
        return toFileInfo(
          slashPath(relative(workspaceRealPath, absolutePath)),
          absolutePath,
          fileStat.size,
          fileStat.mtime,
          normalizeMediaType(mediaType, absolutePath),
        );
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(absolutePath, { force: true }).catch(() => undefined);
        throw error;
      }
    },

    async resolve(agentId, relativePath) {
      const normalized = normalizeWorkspacePath(relativePath);
      const workspaceRealPath = await realpath(await agentStore.resolveWorkspace(agentId));
      const lexicalPath = resolve(workspaceRealPath, normalized);
      if (!isWithin(workspaceRealPath, lexicalPath)) {
        throw new Error("文件路径越出 Agent 工作目录");
      }

      try {
        const fileRealPath = await realpath(lexicalPath);
        if (!isWithin(workspaceRealPath, fileRealPath)) {
          return undefined;
        }
        const fileStat = await lstat(fileRealPath);
        if (!fileStat.isFile()) {
          return undefined;
        }
        return toFileInfo(
          slashPath(relative(workspaceRealPath, fileRealPath)),
          fileRealPath,
          fileStat.size,
          fileStat.mtime,
          mime.getType(fileRealPath) ?? "application/octet-stream",
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }
        throw error;
      }
    },

    async remove(agentId, relativePath) {
      const file = await this.resolve(agentId, relativePath);
      if (file) {
        await rm(file.absolutePath, { force: true });
      }
    },
  };
}

/**
 * 将上传文件名净化为单一、可读且不可跨目录的名称。
 */
export function sanitizeAttachmentName(input: string): string {
  const crossPlatformBase = basename(input.replaceAll("\\", "/"));
  const normalized = crossPlatformBase
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^\p{L}\p{N} ._()-]+/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. -]+|[. -]+$/g, "")
    .slice(0, 160);
  return normalized || "attachment";
}

/**
 * 规范并验证来自消息或 URL 的 cwd 相对路径。
 */
export function normalizeWorkspacePath(input: string): string {
  if (input.includes("\0")) {
    throw new Error("文件路径不能包含 NUL");
  }
  if (!input || isAbsolute(input) || input.includes("\\")) {
    throw new Error("文件路径必须是使用 / 分隔的相对路径");
  }
  const normalized = posix.normalize(input);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("文件路径越出 Agent 工作目录");
  }
  return normalized;
}

export function toPublicWorkspaceFile(file: WorkspaceFileInfo): PublicWorkspaceFile {
  const { absolutePath: _absolutePath, ...publicFile } = file;
  return publicFile;
}

function candidateName(name: string, attempt: number): string {
  if (attempt === 0) {
    return name;
  }
  const extension = extname(name);
  const stem = basename(name, extension);
  return `${stem} (${attempt})${extension}`;
}

function normalizeMediaType(value: string, filePath: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(value)
    ? value.toLowerCase()
    : mime.getType(filePath) ?? "application/octet-stream";
}

function toFileInfo(path: string, absolutePath: string, size: number, modifiedAt: Date, mediaType: string): WorkspaceFileInfo {
  return {
    path,
    name: basename(path),
    mediaType,
    size,
    modifiedAt: modifiedAt.toISOString(),
    absolutePath,
  };
}

function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function slashPath(value: string): string {
  return value.split(sep).join("/");
}
