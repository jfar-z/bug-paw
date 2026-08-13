export type SessionTextRole = "user" | "assistant";

/** 当前活动分支中可供搜索和阅读的一条可见文本消息。 */
export interface SessionTextMessage {
  entryId: string;
  role: SessionTextRole;
  text: string;
  timestamp?: string;
}

/** 一条搜索结果及其安全展示片段。 */
export interface SessionTextSearchHit {
  sessionId: string;
  sessionName?: string;
  sessionFirstMessage: string;
  archived: boolean;
  entryId: string;
  role: SessionTextRole;
  timestamp: string;
  snippet: string;
  matchRanges: Array<{ start: number; end: number }>;
}

/** 搜索请求；Agent 作用域由服务实例固定，不由参数指定。 */
export interface SessionTextSearchRequest {
  query: string;
  limit?: number;
  cursor?: string;
}

/** 有界搜索结果页。 */
export interface SessionTextSearchPage {
  hits: SessionTextSearchHit[];
  nextCursor?: string;
  hasMore: boolean;
}

/** 会话文本阅读请求。 */
export interface SessionTextReadRequest {
  sessionId: string;
  anchorEntryId?: string;
  cursor?: string;
  maxMessages?: number;
}

/** 有界会话文本页。 */
export interface SessionTextReadPage {
  sessionId: string;
  sessionName?: string;
  sessionFirstMessage: string;
  archived: boolean;
  messages: SessionTextMessage[];
  previousCursor?: string;
  nextCursor?: string;
  truncated: boolean;
}

export const SESSION_TEXT_READ_MAX_CHARACTERS = 20_000;
export const SESSION_TEXT_READ_DEFAULT_MESSAGES = 20;
export const SESSION_TEXT_SNIPPET_CONTEXT_CHARACTERS = 80;
export const SESSION_TEXT_SNIPPET_MAX_CHARACTERS = 320;

/**
 * 从 Pi 消息投影可见用户或助手文本。
 *
 * @param _message Pi 历史消息
 */
export function extractVisibleSessionText(_message: unknown): SessionTextMessage | undefined {
  if (!isRecord(_message)
    || (_message.role !== "user" && _message.role !== "assistant")
    || typeof _message.__piEntryId !== "string"
    || !_message.__piEntryId) {
    return undefined;
  }

  const content = visibleTextParts(_message.content, _message.role);
  const text = _message.role === "user"
    ? parseSessionReplayContent(content.join("\n\n")).text
    : content.map((part) => part.trim()).filter(Boolean).join("\n\n");
  if (!text) return undefined;

  const timestamp = normalizeTimestamp(_message.timestamp);
  return {
    entryId: _message.__piEntryId,
    role: _message.role,
    text,
    ...(timestamp ? { timestamp } : {}),
  };
}

/**
 * 构造安全搜索片段和相对于片段的命中范围。
 *
 * @param _text 候选文本
 * @param _query 连续关键词
 */
export function buildSessionTextSnippet(
  _text: string,
  _query: string,
): { snippet: string; matchRanges: Array<{ start: number; end: number }> } {
  if (!_text || !_query) return { snippet: "", matchRanges: [] };

  const normalizedText = foldCaseWithOffsets(_text);
  const normalizedQuery = _query.toLocaleLowerCase();
  if (!normalizedQuery) return { snippet: "", matchRanges: [] };

  const ranges: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  while (searchFrom <= normalizedText.text.length - normalizedQuery.length) {
    const normalizedStart = normalizedText.text.indexOf(normalizedQuery, searchFrom);
    if (normalizedStart < 0) break;
    const normalizedEnd = normalizedStart + normalizedQuery.length;
    const start = normalizedText.starts[normalizedStart];
    const end = normalizedText.ends[normalizedEnd - 1];
    if (start !== undefined && end !== undefined) ranges.push({ start, end });
    searchFrom = normalizedStart + Math.max(1, normalizedQuery.length);
  }
  if (ranges.length === 0) return { snippet: "", matchRanges: [] };

  const first = ranges[0]!;
  let snippetStart = Math.max(0, first.start - SESSION_TEXT_SNIPPET_CONTEXT_CHARACTERS);
  let snippetEnd = Math.min(_text.length, first.end + SESSION_TEXT_SNIPPET_CONTEXT_CHARACTERS);
  if (snippetEnd - snippetStart > SESSION_TEXT_SNIPPET_MAX_CHARACTERS) {
    snippetEnd = snippetStart + SESSION_TEXT_SNIPPET_MAX_CHARACTERS;
  }
  snippetStart = safeSliceStart(_text, snippetStart);
  snippetEnd = safeSliceEnd(_text, snippetEnd);

  return {
    snippet: _text.slice(snippetStart, snippetEnd),
    matchRanges: ranges
      .filter(({ start, end }) => start >= snippetStart && end <= snippetEnd)
      .map(({ start, end }) => ({ start: start - snippetStart, end: end - snippetStart })),
  };
}

function foldCaseWithOffsets(text: string): { text: string; starts: number[]; ends: number[] } {
  let offset = 0;
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  for (const character of text) {
    const start = offset;
    offset += character.length;
    const folded = character.toLocaleLowerCase();
    normalized += folded;
    for (let index = 0; index < folded.length; index += 1) {
      starts.push(start);
      ends.push(offset);
    }
  }
  return { text: normalized, starts, ends };
}

function visibleTextParts(content: unknown, role: SessionTextRole): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") return [];
    return role === "user" || part.text.trim() ? [part.text] : [];
  });
}

function normalizeTimestamp(value: unknown): string | undefined {
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : undefined;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function safeSliceStart(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return isLowSurrogate(text.charCodeAt(index)) && isHighSurrogate(text.charCodeAt(index - 1))
    ? index - 1
    : index;
}

function safeSliceEnd(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  return isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))
    ? index + 1
    : index;
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
import { parseSessionReplayContent } from "./session-message-context";
