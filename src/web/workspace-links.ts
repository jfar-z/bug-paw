import type { WorkspaceEntry } from "../shared/contracts";
import { ApiClientError } from "./api";

export type WorkspaceLinkIntent =
  | { kind: "workspace"; path: string }
  | { kind: "blocked"; href: string; message: string }
  | { kind: "passthrough" };

export type WorkspaceReferenceLocation =
  | { kind: "directory"; directory: string }
  | { kind: "file"; directory: string; entry: WorkspaceEntry }
  | { kind: "missing"; directory: string; path: string };

type WorkspaceDirectoryReader = (directory: string) => Promise<WorkspaceEntry[]>;

/** 将 Markdown href 分类为浏览器链接或当前 Agent 的安全工作目录引用。 */
export function classifyWorkspaceLink(href: string): WorkspaceLinkIntent {
  const trimmed = href.trim();
  if (/^file:/i.test(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.includes("\\")) {
    return blockedLink(href, "本地绝对路径无法从浏览器打开");
  }
  if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("#") || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return { kind: "passthrough" };
  }

  const pathOnly = trimmed.split(/[?#]/, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    return blockedLink(href, "文件路径编码无效");
  }
  if (!decoded || decoded.includes("\0")) return blockedLink(href, "文件路径无效");

  const segments: string[] = [];
  for (const segment of decoded.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return blockedLink(href, "文件路径已越出当前 Agent 工作目录");
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (segments.length === 0) return blockedLink(href, "文件路径无效");
  return { kind: "workspace", path: segments.join("/") };
}

/** 解析引用目标；失效路径保留最深可访问目录作为浏览上下文。 */
export async function locateWorkspaceReference(
  path: string,
  listDirectory: WorkspaceDirectoryReader,
): Promise<WorkspaceReferenceLocation> {
  const segments = path.split("/");
  const name = segments.at(-1) ?? path;
  const immediateParent = segments.slice(0, -1).join("/");
  let candidate = immediateParent;
  while (true) {
    try {
      const entries = await listDirectory(candidate);
      if (candidate === immediateParent) {
        const entry = entries.find((item) => item.name === name && item.path === path);
        if (entry?.kind === "file") return { kind: "file", directory: candidate, entry };
        if (entry?.kind === "directory") return { kind: "directory", directory: entry.path };
      }
      return { kind: "missing", directory: candidate, path };
    } catch (error) {
      if (!isMissingWorkspaceTarget(error)) throw error;
    }
    if (!candidate) return { kind: "missing", directory: "", path };
    candidate = candidate.split("/").slice(0, -1).join("/");
  }
}

function blockedLink(href: string, message: string): WorkspaceLinkIntent {
  return { kind: "blocked", href, message };
}

function isMissingWorkspaceTarget(error: unknown): boolean {
  return error instanceof ApiClientError && (error.code === "NOT_FOUND" || error.code === "FILE_NOT_FOUND");
}
