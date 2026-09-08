import { open, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import mime from "mime";
import type { DataFileSummary, DataFileTextPreview } from "../shared/contracts";
import type { DataPaths } from "./paths";
import { AgentStore } from "./agents/agent-store";

const TEXT_PREVIEW_LIMIT_BYTES = 512 * 1024;
const FILE_SIGNATURE_BYTES = 4 * 1024;
const TEXT_EXTENSIONS = new Set([".txt", ".md", ".mdx", ".json", ".yaml", ".yml", ".toml", ".ini", ".csv", ".ts", ".tsx", ".js", ".jsx", ".css", ".html", ".xml", ".py", ".java", ".go", ".rs", ".sh", ".sql", ".log"]);

/** `/data` 文件读取失败时使用的稳定错误。 */
export class DataFileError extends Error {
  /** 错误分类。 */
  readonly code: "INVALID_PATH" | "NOT_FOUND" | "UNSUPPORTED_FILE" | "TEXT_PREVIEW_UNAVAILABLE";

  /**
   * 创建文件读取错误。
   *
   * @param code 稳定错误分类
   * @param message 面向用户的错误说明
   */
  constructor(code: DataFileError["code"], message: string) {
    super(message);
    this.name = "DataFileError";
    this.code = code;
  }
}

/** 仅在服务端使用的 `/data` 文件信息。 */
export interface ResolvedDataFile extends DataFileSummary {
  /** 文件在容器内的真实绝对路径。 */
  absolutePath: string;
}

/** 登录用户通过 Markdown 链接访问 `/data` 文件的服务。 */
export interface DataFileService {
  resolve(agentId: string, path: string): Promise<ResolvedDataFile>;
  readText(agentId: string, path: string): Promise<DataFileTextPreview>;
}

/**
 * 创建以整个挂载数据目录为边界的只读文件服务。
 *
 * @param paths 运行时数据目录
 * @param agents Agent 存储，用于解析相对链接的 cwd
 */
export function createDataFileService(paths: DataPaths, agents: AgentStore = new AgentStore(paths)): DataFileService {
  const mediaTypeCache = new Map<string, string>();
  const dataRootPromise = realpath(paths.rootDir);

  const resolveFile = async (agentId: string, path: string): Promise<ResolvedDataFile> => {
    const requestedPath = normalizeRequestedPath(path);
    const dataRoot = await dataRootPromise;
    const candidate = requestedPath === "/data" || requestedPath.startsWith("/data/")
      ? resolve(dataRoot, relative("/data", requestedPath))
      : isAbsolute(requestedPath)
        ? resolve(requestedPath)
        : resolve(await agents.resolveWorkspace(agentId), requestedPath);
    if (!isWithin(dataRoot, candidate)) throw new DataFileError("INVALID_PATH", "文件路径必须位于 /data 目录内");

    const absolutePath = await realpath(candidate).catch((error) => {
      if (isMissing(error)) throw new DataFileError("NOT_FOUND", "文件不存在或不可读取");
      throw error;
    });
    if (!isWithin(dataRoot, absolutePath)) throw new DataFileError("INVALID_PATH", "文件链接目标越出 /data 目录");

    const info = await stat(absolutePath).catch((error) => {
      if (isMissing(error)) throw new DataFileError("NOT_FOUND", "文件不存在或不可读取");
      throw error;
    });
    if (!info.isFile()) throw new DataFileError("UNSUPPORTED_FILE", "当前链接不是普通文件");

    const cacheKey = `${absolutePath}:${info.size}:${info.mtimeMs}`;
    let mediaType = mediaTypeCache.get(cacheKey);
    if (!mediaType) {
      mediaType = await detectMediaType(absolutePath);
      if (mediaTypeCache.size >= 512) mediaTypeCache.delete(mediaTypeCache.keys().next().value ?? "");
      mediaTypeCache.set(cacheKey, mediaType);
    }
    return {
      path: toDataPath(dataRoot, absolutePath),
      name: basename(absolutePath),
      mediaType,
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      absolutePath,
    };
  };

  return {
    resolve: resolveFile,
    async readText(agentId, path) {
      const file = await resolveFile(agentId, path);
      if (!isTextFile(file.mediaType, file.name)) {
        throw new DataFileError("TEXT_PREVIEW_UNAVAILABLE", "当前文件不支持文本预览");
      }
      const handle = await open(file.absolutePath, "r");
      try {
        const length = Math.min(file.size, TEXT_PREVIEW_LIMIT_BYTES + 1);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, 0);
        const content = buffer.subarray(0, Math.min(bytesRead, TEXT_PREVIEW_LIMIT_BYTES));
        if (content.includes(0)) throw new DataFileError("TEXT_PREVIEW_UNAVAILABLE", "当前文件不是可预览的文本内容");
        let decodedContent: string;
        try {
          decodedContent = new TextDecoder("utf-8", { fatal: true }).decode(content);
        } catch {
          throw new DataFileError("TEXT_PREVIEW_UNAVAILABLE", "当前文件不是有效的 UTF-8 文本");
        }
        return {
          path: file.path,
          content: decodedContent,
          truncated: bytesRead > TEXT_PREVIEW_LIMIT_BYTES || file.size > TEXT_PREVIEW_LIMIT_BYTES,
        };
      } finally {
        await handle.close();
      }
    },
  };
}

/** 清理 Markdown 链接路径，不把 query 或 hash 解释成文件名。 */
function normalizeRequestedPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("\0")) throw new DataFileError("INVALID_PATH", "文件路径无效");
  const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? "";
  if (/^file:/i.test(pathOnly)) {
    let url: URL;
    try {
      url = new URL(pathOnly);
    } catch {
      throw new DataFileError("INVALID_PATH", "本地文件链接无效");
    }
    if (url.protocol !== "file:" || (url.hostname && url.hostname !== "localhost")) {
      throw new DataFileError("INVALID_PATH", "本地文件链接无效");
    }
    try {
      return decodeURIComponent(url.pathname);
    } catch {
      throw new DataFileError("INVALID_PATH", "本地文件链接编码无效");
    }
  }
  try {
    return decodeURIComponent(pathOnly);
  } catch {
    throw new DataFileError("INVALID_PATH", "文件路径编码无效");
  }
}

/** 读取少量文件头识别常见媒体，未知类型回退到扩展名映射。 */
async function detectMediaType(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(FILE_SIGNATURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    return detectSignature(content, path) ?? detectTextMediaType(content, path) ?? "application/octet-stream";
  } finally {
    await handle.close();
  }
}

/** 根据常见魔数判断浏览器可预览媒体类型。 */
function detectSignature(content: Buffer, path: string): string | undefined {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
  if (content.subarray(0, 6).toString("ascii") === "GIF87a" || content.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (content.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  if (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (looksLikeSvg(content)) return "image/svg+xml";
  if (content.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf";
  if (content.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = content.subarray(8, 12).toString("ascii").toLowerCase();
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand.startsWith("m4a") || brand.startsWith("m4b")) return "audio/mp4";
    if (brand === "qt  ") return "video/quicktime";
    return "video/mp4";
  }
  if (content.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return extname(path).toLowerCase() === ".mkv" ? "video/x-matroska" : "video/webm";
  }
  if (content.subarray(0, 4).toString("ascii") === "OggS") return "audio/ogg";
  if (content.subarray(0, 4).toString("ascii") === "fLaC") return "audio/flac";
  if (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WAVE") return "audio/wav";
  if (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "AVI ") return "video/x-msvideo";
  if (content.subarray(0, 3).toString("ascii") === "ID3" || content[0] === 0xff && (content[1] & 0xe0) === 0xe0) return "audio/mpeg";
  return undefined;
}

function looksLikeSvg(content: Buffer): boolean {
  if (content.includes(0)) return false;
  const prefix = content.toString("utf8").replace(/^\uFEFF?\s*/, "");
  return /^(?:<\?xml[^>]*>\s*)?(?:<!--(?:.|\n|\r)*?-->\s*)*<svg(?:\s|>)/i.test(prefix);
}

/** 仅在文件头看起来是文本时使用扩展名细分 MIME，避免伪造媒体后缀。 */
function detectTextMediaType(content: Buffer, path: string): string | undefined {
  if (content.includes(0)) return undefined;
  let controls = 0;
  for (const byte of content) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x0c) controls += 1;
  }
  if (content.length > 0 && controls / content.length > 0.02) return undefined;
  const extension = extname(path).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return undefined;
  return mime.getType(path) ?? "text/plain";
}

function isTextFile(mediaType: string, name: string): boolean {
  return mediaType.startsWith("text/") || TEXT_EXTENSIONS.has(extname(name).toLowerCase());
}

function toDataPath(root: string, absolutePath: string): string {
  const child = relative(root, absolutePath).split(sep).join("/");
  return child ? `/data/${child}` : "/data";
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
