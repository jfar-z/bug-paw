/**
 * 用户在消息中显式引用的工作流、知识库和工作区资源。
 */
export type AgentReference = SkillReference | KnowledgeReference | FileReference;

/**
 * 浏览器提交给服务端、尚未可信化的引用标识。
 */
export type AgentReferenceInput =
  | { type: "skill"; name: string }
  | { type: "knowledge"; id: string }
  | { type: "file"; path: string };

/**
 * Pi 技能工作流引用。
 */
export interface SkillReference {
  type: "skill";
  name: string;
}

/**
 * 当前 Agent 可见知识库的引用。
 */
export interface KnowledgeReference {
  type: "knowledge";
  id: string;
  name: string;
}

/**
 * 工作区文件或目录引用。
 */
export interface FileReference {
  type: "file";
  path: string;
  kind: "file" | "directory";
  name: string;
}

/**
 * 从持久化的用户消息中提取由服务端生成的引用标签。
 */
export function parseAgentReferences(text: string): { text: string; references: AgentReference[] } {
  const references: AgentReference[] = [];
  const nextText = text.replace(/<agent_references\s+([^>]*?)\/>/g, (tag, attributes: string) => {
    const reference = parseAgentReference(attributes);
    if (!reference || references.length >= 20) {
      return tag;
    }
    references.push(reference);
    return "";
  });

  if (references.length === 0) {
    return { text, references };
  }
  return {
    text: nextText.replace(/\n{3,}/g, "\n\n").trim(),
    references,
  };
}

/**
 * 校验并解析单个 XML 自闭合标签，损坏标签会保留为普通消息文本。
 */
function parseAgentReference(value: string): AgentReference | undefined {
  const attributes = parseAttributes(value);
  if (!attributes || attributes.version !== "1") {
    return undefined;
  }
  if (attributes.type === "skill" && hasExactKeys(attributes, ["version", "type", "name"]) && isSafeName(attributes.name)) {
    return { type: "skill", name: attributes.name };
  }
  if (
    attributes.type === "knowledge"
    && hasExactKeys(attributes, ["version", "type", "id", "name"])
    && isSafeName(attributes.id)
    && isSafeName(attributes.name)
  ) {
    return { type: "knowledge", id: attributes.id, name: attributes.name };
  }
  if (
    attributes.type === "file"
    && hasExactKeys(attributes, ["version", "type", "path", "kind"])
    && isSafeReferencePath(attributes.path)
    && (attributes.kind === "file" || attributes.kind === "directory")
  ) {
    return {
      type: "file",
      path: attributes.path,
      kind: attributes.kind,
      name: referenceNameFromPath(attributes.path),
    };
  }
  return undefined;
}

function parseAttributes(value: string): Record<string, string> | undefined {
  const attributes: Record<string, string> = {};
  const matcher = /([a-z]+)="([^"]*)"/g;
  let cursor = 0;
  for (const match of value.matchAll(matcher)) {
    if (match.index === undefined || !/^\s*$/.test(value.slice(cursor, match.index)) || attributes[match[1]] !== undefined) {
      return undefined;
    }
    attributes[match[1]] = unescapeXmlAttribute(match[2]);
    cursor = match.index + match[0].length;
  }
  return /^\s*$/.test(value.slice(cursor)) ? attributes : undefined;
}

function hasExactKeys(attributes: Record<string, string>, keys: string[]): boolean {
  const actual = Object.keys(attributes);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isSafeName(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("\0");
}

/**
 * 仅接受相对 POSIX 路径，避免历史内容造成路径穿越或平台歧义。
 */
export function isSafeReferencePath(path: string | undefined): path is string {
  return typeof path === "string"
    && path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && path.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * 从相对路径生成气泡展示名称，不将完整工作区路径重复展示给用户。
 */
export function referenceNameFromPath(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function unescapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
