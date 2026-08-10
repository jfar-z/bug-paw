import { parseAgentReferences, type AgentReference } from "./agent-reference-contracts";

/** 从 Pi 历史消息还原供编辑器使用的正文、附件和引用。 */
export interface SessionReplayContent {
  /** 不包含内部协议标签的可编辑正文。 */
  text: string;
  /** 由文件协议或文件引用声明的受管相对路径。 */
  filePaths: string[];
  /** 由现有引用协议解析出的上下文引用。 */
  references: AgentReference[];
}

/**
 * 拆解 Pi 保存的历史 prompt，避免将内部协议标签暴露到编辑器。
 *
 * @param rawPrompt Pi 保存的原始用户消息
 */
export function parseSessionReplayContent(rawPrompt: string): SessionReplayContent {
  const parsedReferences = parseAgentReferences(rawPrompt);
  const filePaths: string[] = [];
  const seen = new Set<string>();
  const addPath = (path: string) => {
    if (isSafeRelativePath(path) && !seen.has(path)) {
      seen.add(path);
      filePaths.push(path);
    }
  };

  for (const reference of parsedReferences.references) {
    if (reference.type === "file") addPath(reference.path);
  }

  const text = parsedReferences.text.replace(/<pi_agent_files version="1">\n([\s\S]*?)\n<\/pi_agent_files>/g, (block, payload: string) => {
    const paths = parseFilePaths(payload);
    if (!paths) return block;
    paths.forEach(addPath);
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();

  return { text, filePaths, references: parsedReferences.references };
}

function parseFilePaths(payload: string): string[] | undefined {
  try {
    const value = JSON.parse(payload) as unknown;
    if (!isRecord(value) || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 20) return undefined;
    const paths = value.files.map((file) => isRecord(file) && typeof file.path === "string" && isSafeRelativePath(file.path) ? file.path : undefined);
    return paths.every((path): path is string => path !== undefined) ? paths : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every((part) => part !== "..");
}
