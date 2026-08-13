import type { WorkspaceFileRef } from "../shared/contracts";
import { parseAgentReferences, type AgentReference } from "../shared/agent-reference-contracts";

export interface UserEntry {
  id: string;
  type: "user";
  text: string;
  files: WorkspaceFileRef[];
  references: AgentReference[];
  source?: "scheduled";
  piEntryId?: string;
  branch?: { index: number; count: number; previousEntryId?: string; nextEntryId?: string; previousNavigationEntryId?: string; nextNavigationEntryId?: string };
}

export interface MarkdownBlock {
  id: string;
  type: "markdown";
  text: string;
  streaming: boolean;
  piEntryId?: string;
  revealStart?: number;
  revealPhase?: number;
}

export interface ThinkingBlock {
  id: string;
  type: "thinking";
  text: string;
  streaming: boolean;
  revealStart?: number;
  revealPhase?: number;
}

export interface FileBlock {
  id: string;
  type: "files";
  files: WorkspaceFileRef[];
}

export interface ToolBlock {
  id: string;
  type: "tool";
  callId: string;
  name: string;
  args: unknown;
  parameterBytes?: number;
  parameterPath?: string;
  partialResult?: unknown;
  result?: unknown;
  details?: unknown;
  status: "preparing" | "parameterizing" | "running" | "completed" | "cancelled" | "error";
}

export type AgentBlock = MarkdownBlock | ThinkingBlock | FileBlock | ToolBlock;

export interface AgentTurn {
  id: string;
  type: "agent";
  blocks: AgentBlock[];
  sourceUserEntryId?: string;
}

export type ConversationEntry = UserEntry | AgentTurn;

export type TimelineEvent =
  | { type: "user_message"; text: string; files?: WorkspaceFileRef[]; references?: AgentReference[]; id?: string }
  | { type: "generation_started" }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_finished" }
  | { type: "tool_preparing"; callId: string; toolName: string }
  | { type: "tool_parameters_streaming"; callId: string; toolName: string; generatedBytes: number; path?: string }
  | { type: "tool_prepared"; callId: string; toolName: string; args: unknown }
  | { type: "tool_started"; callId: string; toolName: string; args: unknown }
  | { type: "tool_updated"; callId: string; toolName: string; partialResult: unknown }
  | { type: "tool_finished"; callId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "generation_finished"; outcome: "completed" | "aborted" | "error" };

/**
 * 将实时事件归并到单一有序时间线，文件与工具更新保持原始位置。
 */
export function reduceTimeline(entries: ConversationEntry[], event: TimelineEvent): ConversationEntry[] {
  if (event.type === "user_message") {
    return [...entries, {
      id: event.id ?? createId("user", entries),
      type: "user",
      text: event.text,
      files: event.files ?? [],
      references: event.references ?? [],
    }];
  }
  if (event.type === "generation_started") {
    return ensureAgentTurn(entries).next;
  }
  if (event.type === "text_delta") {
    const { next, turnIndex } = ensureAgentTurn(entries);
    const turn = next[turnIndex] as AgentTurn;
    const last = turn.blocks.at(-1);
    let blocks: AgentBlock[];
    if (last?.type === "markdown" && last.streaming) {
      const appended = splitAgentText(last.text + event.delta, last.id, true);
      // 保留原 Markdown 块标识，避免每个 token 都导致 React 卸载并重建整块内容。
      if (appended[0]?.type === "markdown") {
        appended[0] = { ...appended[0], id: last.id };
      }
      const revealStart = appended.length === 1 ? last.text.length : 0;
      blocks = [
        ...turn.blocks.slice(0, -1),
        ...markStreamingTail(appended, revealStart, (last.revealPhase ?? 0) + 1),
      ];
    } else {
      blocks = [
        ...turn.blocks,
        ...markStreamingTail(splitAgentText(event.delta, createId("markdown", next), true), 0, 0),
      ];
    }
    return replaceTurn(next, turnIndex, { ...turn, blocks });
  }
  if (event.type === "thinking_delta") {
    const { next, turnIndex } = ensureAgentTurn(entries);
    const turn = next[turnIndex] as AgentTurn;
    const last = turn.blocks.at(-1);
    const blocks: AgentBlock[] = last?.type === "thinking" && last.streaming
      ? [...turn.blocks.slice(0, -1), {
        ...last,
        text: last.text + event.delta,
        revealStart: last.text.length,
        revealPhase: (last.revealPhase ?? 0) + 1,
      }]
      : [...turn.blocks, {
        id: createId("thinking", next),
        type: "thinking",
        text: event.delta,
        streaming: true,
        revealStart: 0,
        revealPhase: 0,
      }];
    return replaceTurn(next, turnIndex, { ...turn, blocks });
  }
  if (event.type === "thinking_finished") {
    const turnIndex = findLastAgentTurn(entries);
    if (turnIndex < 0) {
      return entries;
    }
    const turn = entries[turnIndex] as AgentTurn;
    const lastStreamingThinkingIndex = turn.blocks.findLastIndex((block) => block.type === "thinking" && block.streaming);
    if (lastStreamingThinkingIndex < 0) {
      return entries;
    }
    const blocks = [...turn.blocks];
    const thinking = blocks[lastStreamingThinkingIndex] as ThinkingBlock;
    blocks[lastStreamingThinkingIndex] = { ...thinking, streaming: false };
    return replaceTurn(entries, turnIndex, { ...turn, blocks });
  }
  if (event.type === "generation_finished") {
    const turnIndex = findLastAgentTurn(entries);
    if (turnIndex < 0) {
      return entries;
    }
    const turn = entries[turnIndex] as AgentTurn;
    return replaceTurn(entries, turnIndex, {
      ...turn,
      blocks: turn.blocks.map((block) => {
        if (block.type === "markdown" || block.type === "thinking") return { ...block, streaming: false };
        if (block.type === "tool" && (block.status === "preparing" || block.status === "parameterizing") && event.outcome !== "completed") {
          return { ...block, status: "cancelled" };
        }
        return block;
      }),
    });
  }

  const existing = findTool(entries, event.callId);
  if (existing) {
    const turn = entries[existing.turnIndex] as AgentTurn;
    const tool = turn.blocks[existing.blockIndex] as ToolBlock;
    const blocks = [...turn.blocks];
    blocks[existing.blockIndex] = updateToolFromEvent(tool, event);
    return replaceTurn(entries, existing.turnIndex, { ...turn, blocks });
  }

  const { next, turnIndex } = ensureAgentTurn(entries);
  const turn = next[turnIndex] as AgentTurn;
  return replaceTurn(next, turnIndex, { ...turn, blocks: [...turn.blocks, createToolFromEvent(event, next)] });
}

/**
 * 按 pi 原始消息顺序恢复用户消息、Agent 文本、文件和工具调用。
 */
export function parsePiHistory(messages: unknown[], streaming = false): ConversationEntry[] {
  let entries: ConversationEntry[] = [];
  const tools = new Map<string, { turnIndex: number; blockIndex: number }>();

  let sourceUserEntryId: string | undefined;
  messages.forEach((message, messageIndex) => {
    if (!isRecord(message) || typeof message.role !== "string") {
      return;
    }
    if (message.role === "user") {
      const parsed = parseUserContext(extractContentText(message.content));
      if (parsed.text || parsed.files.length > 0 || parsed.references.length > 0) {
        sourceUserEntryId = typeof message.__piEntryId === "string" ? message.__piEntryId : undefined;
        entries = [...entries, {
          id: `history-user-${messageIndex}`,
          type: "user",
          ...parsed,
          ...(parsed.text.startsWith("这是定时任务发出的消息") ? { source: "scheduled" as const } : {}),
          ...(sourceUserEntryId ? { piEntryId: sourceUserEntryId } : {}),
          ...(isBranchNavigation(message.__piBranch) ? { branch: message.__piBranch } : {}),
        }];
      }
      return;
    }
    if (message.role === "assistant" && (Array.isArray(message.content) || typeof message.content === "string")) {
      const ensured = ensureAgentTurn(entries);
      entries = ensured.next;
      const turn = entries[ensured.turnIndex] as AgentTurn;
      const blocks = [...turn.blocks];
      const assistantEntryId = typeof message.__piEntryId === "string" ? message.__piEntryId : undefined;
      let entryAnchorAssigned = false;
      const assistantParts = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
      assistantParts.forEach((part, partIndex) => {
        if (!isRecord(part)) {
          return;
        }
        if (part.type === "text" && typeof part.text === "string" && part.text) {
          const parsedBlocks = splitAgentText(part.text, `history-${messageIndex}-${partIndex}`, false);
          if (assistantEntryId && !entryAnchorAssigned) {
            const markdownIndex = parsedBlocks.findIndex((block) => block.type === "markdown" && block.text.trim());
            if (markdownIndex >= 0) {
              parsedBlocks[markdownIndex] = { ...parsedBlocks[markdownIndex] as MarkdownBlock, piEntryId: assistantEntryId };
              entryAnchorAssigned = true;
            }
          }
          blocks.push(...parsedBlocks);
        }
        if (part.type === "thinking") {
          const text = extractThinkingText(part);
          if (text) {
            blocks.push({ id: `history-${messageIndex}-${partIndex}-thinking`, type: "thinking", text, streaming: false });
          }
        }
        if (part.type === "toolCall" && typeof part.id === "string" && typeof part.name === "string") {
          const blockIndex = blocks.length;
          blocks.push({
            id: `history-tool-${part.id}`,
            type: "tool",
            callId: part.id,
            name: part.name,
            args: part.arguments,
            status: "running",
          });
          tools.set(part.id, { turnIndex: ensured.turnIndex, blockIndex });
        }
      });
      entries = replaceTurn(entries, ensured.turnIndex, { ...turn, blocks, ...(sourceUserEntryId ? { sourceUserEntryId } : {}) });
      return;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const location = tools.get(message.toolCallId) ?? findTool(entries, message.toolCallId);
      const result = extractToolResult(message.content);
      if (location) {
        const turn = entries[location.turnIndex] as AgentTurn;
        const blocks = [...turn.blocks];
        const tool = blocks[location.blockIndex] as ToolBlock;
        blocks[location.blockIndex] = {
          ...tool,
          result,
          details: message.details,
          status: message.isError === true ? "error" : "completed",
        };
        entries = replaceTurn(entries, location.turnIndex, { ...turn, blocks });
        return;
      }
      const ensured = ensureAgentTurn(entries);
      const turn = ensured.next[ensured.turnIndex] as AgentTurn;
      const name = typeof message.toolName === "string" ? message.toolName : "unknown";
      const block: ToolBlock = {
        id: `history-tool-${message.toolCallId}`,
        type: "tool",
        callId: message.toolCallId,
        name,
        args: undefined,
        result,
        details: message.details,
        status: message.isError === true ? "error" : "completed",
      };
      entries = replaceTurn(ensured.next, ensured.turnIndex, { ...turn, blocks: [...turn.blocks, block] });
    }
  });
  return streaming ? markLastMarkdownStreaming(entries) : entries;
}

/**
 * 将未知工具值转换为适合等宽文本区域展示的安全字符串。
 */
export function formatToolValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return "（无）";
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return `[无法序列化] ${String(value)}`;
  }
}

function splitAgentText(text: string, idPrefix: string, streaming: boolean): AgentBlock[] {
  const segments = parseFileSegments(text);
  return segments.map((segment, index): AgentBlock => segment.type === "files"
    ? { id: `${idPrefix}-files-${index}`, type: "files", files: segment.files }
    : {
      id: `${idPrefix}-markdown-${index}`,
      type: "markdown",
      text: segment.text,
      streaming: streaming && index === segments.length - 1,
    });
}

/**
 * 标记最后一个流式 Markdown 块中属于本次事件的新增文字范围。
 */
function markStreamingTail(blocks: AgentBlock[], revealStart: number, revealPhase: number): AgentBlock[] {
  const index = blocks.findLastIndex((block) => block.type === "markdown" && block.streaming);
  if (index < 0) {
    return blocks;
  }
  const block = blocks[index] as MarkdownBlock;
  const next = [...blocks];
  next[index] = {
    ...block,
    revealStart: Math.min(revealStart, block.text.length),
    revealPhase,
  };
  return next;
}

/**
 * 兼容 Pi 历史消息中不同版本的思考文本字段。
 */
function extractThinkingText(part: Record<string, unknown>): string | undefined {
  if (typeof part.thinking === "string") {
    return part.thinking;
  }
  return typeof part.text === "string" ? part.text : undefined;
}

function parseUserContext(text: string): { text: string; files: WorkspaceFileRef[]; references: AgentReference[] } {
  const parsedReferences = parseAgentReferences(text);
  const parsedFiles = parseUserFiles(parsedReferences.text);
  const referenceFiles = parsedReferences.references.flatMap((reference) => reference.type === "file" ? [{ path: reference.path }] : []);
  return {
    text: parsedFiles.text,
    files: mergeFiles(parsedFiles.files, referenceFiles),
    references: parsedReferences.references,
  };
}

function parseUserFiles(text: string): { text: string; files: WorkspaceFileRef[] } {
  const segments = parseFileSegments(text);
  const files = segments.flatMap((segment) => segment.type === "files" ? segment.files : []);
  if (files.length === 0) {
    return { text, files: [] };
  }
  return {
    text: segments.flatMap((segment) => segment.type === "markdown" ? [segment.text] : []).join("\n\n").trim(),
    files,
  };
}

/**
 * 新旧文件协议同时存在时按路径去重，避免消息气泡重复展示附件。
 */
function mergeFiles(...groups: WorkspaceFileRef[][]): WorkspaceFileRef[] {
  const paths = new Set<string>();
  return groups.flatMap((files) => files.filter((file) => {
    if (paths.has(file.path)) {
      return false;
    }
    paths.add(file.path);
    return true;
  }));
}

type FileSegment = { type: "markdown"; text: string } | { type: "files"; files: WorkspaceFileRef[] };

function parseFileSegments(text: string): FileSegment[] {
  const pattern = /<pi_agent_files version="1">\n([\s\S]*?)\n<\/pi_agent_files>/g;
  const matches: Array<{ index: number; end: number; files: WorkspaceFileRef[] }> = [];
  for (const match of text.matchAll(pattern)) {
    const files = parseFilePayload(match[1]);
    if (files && match.index !== undefined) {
      matches.push({ index: match.index, end: match.index + match[0].length, files });
    }
  }
  if (matches.length === 0) {
    return [{ type: "markdown", text }];
  }

  const segments: FileSegment[] = [];
  let cursor = 0;
  matches.forEach((match, index) => {
    let markdown = text.slice(cursor, match.index);
    if (index > 0) {
      markdown = markdown.replace(/^\n+/, "");
    }
    markdown = markdown.replace(/\n+$/, "");
    pushMarkdown(segments, markdown);
    segments.push({ type: "files", files: match.files });
    cursor = match.end;
  });
  // 只清理文件协议与后续 Markdown 之间的结构空行，保留文本末尾原始空白。
  const trailing = text.slice(cursor).replace(/^\n+/, "");
  if (trailing) {
    pushMarkdown(segments, trailing);
  }
  return segments;
}

function parseFilePayload(value: string): WorkspaceFileRef[] | undefined {
  try {
    const payload = JSON.parse(value) as unknown;
    if (!isRecord(payload) || !Array.isArray(payload.files) || payload.files.length === 0 || payload.files.length > 20) {
      return undefined;
    }
    const files = payload.files.map((file) => isRecord(file) && typeof file.path === "string" && isSafeRelativePath(file.path)
      ? { path: file.path }
      : undefined);
    return files.every((file): file is WorkspaceFileRef => file !== undefined) ? files : undefined;
  } catch {
    return undefined;
  }
}

function isSafeRelativePath(path: string): boolean {
  return path.length > 0
    && !path.startsWith("/")
    && !path.includes("\\")
    && !path.includes("\0")
    && path.split("/").every((segment) => segment !== "..");
}

function pushMarkdown(segments: FileSegment[], value: string): void {
  if (value) {
    segments.push({ type: "markdown", text: value });
  }
}

function ensureAgentTurn(entries: ConversationEntry[]): { next: ConversationEntry[]; turnIndex: number } {
  const lastIndex = entries.length - 1;
  if (lastIndex >= 0 && entries[lastIndex].type === "agent") {
    return { next: entries, turnIndex: lastIndex };
  }
  return { next: [...entries, { id: createId("agent", entries), type: "agent", blocks: [] }], turnIndex: entries.length };
}

function replaceTurn(entries: ConversationEntry[], index: number, turn: AgentTurn): ConversationEntry[] {
  const next = [...entries];
  next[index] = turn;
  return next;
}

/**
 * 让活动快照的最后一个文本块继续接收后续增量。
 */
function markLastMarkdownStreaming(entries: ConversationEntry[]): ConversationEntry[] {
  const turnIndex = findLastAgentTurn(entries);
  if (turnIndex < 0) {
    return entries;
  }
  const turn = entries[turnIndex] as AgentTurn;
  const block = turn.blocks.at(-1);
  if (block?.type !== "markdown") {
    return entries;
  }
  return replaceTurn(entries, turnIndex, {
    ...turn,
    blocks: [...turn.blocks.slice(0, -1), {
      ...block,
      streaming: true,
      revealStart: block.text.length,
      revealPhase: 0,
    }],
  });
}

function findLastAgentTurn(entries: ConversationEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === "agent") {
      return index;
    }
  }
  return -1;
}

function findTool(entries: ConversationEntry[], callId: string): { turnIndex: number; blockIndex: number } | undefined {
  for (let turnIndex = entries.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const entry = entries[turnIndex];
    if (entry.type !== "agent") {
      continue;
    }
    const blockIndex = entry.blocks.findIndex((block) => block.type === "tool" && block.callId === callId);
    if (blockIndex >= 0) {
      return { turnIndex, blockIndex };
    }
  }
  return undefined;
}

function createToolFromEvent(
  event: ToolTimelineEvent,
  entries: ConversationEntry[],
): ToolBlock {
  return updateToolFromEvent({
    id: createId("tool", entries),
    type: "tool",
    callId: event.callId,
    name: event.toolName,
    args: undefined,
    status: event.type === "tool_preparing" || event.type === "tool_prepared" ? "preparing" : event.type === "tool_parameters_streaming" ? "parameterizing" : "running",
  }, event);
}

function updateToolFromEvent(
  tool: ToolBlock,
  event: ToolTimelineEvent,
): ToolBlock {
  if (event.type === "tool_preparing") {
    return { ...tool, name: event.toolName, status: tool.status === "preparing" ? "preparing" : tool.status };
  }
  if (event.type === "tool_parameters_streaming") {
    return {
      ...tool,
      name: event.toolName,
      parameterBytes: event.generatedBytes,
      ...(event.path ? { parameterPath: event.path } : {}),
      status: tool.status === "preparing" || tool.status === "parameterizing" ? "parameterizing" : tool.status,
    };
  }
  if (event.type === "tool_prepared") {
    return { ...tool, name: event.toolName, args: event.args, status: tool.status === "preparing" ? "preparing" : tool.status };
  }
  if (event.type === "tool_started") {
    return { ...tool, name: event.toolName, args: event.args, status: "running" };
  }
  if (event.type === "tool_updated") {
    const normalized = normalizeToolPayload(event.partialResult);
    return { ...tool, name: event.toolName, partialResult: normalized.value, details: normalized.details ?? tool.details, status: "running" };
  }
  const normalized = normalizeToolPayload(event.result);
  return {
    ...tool,
    name: event.toolName,
    result: normalized.value,
    details: normalized.details ?? tool.details,
    status: event.isError ? "error" : "completed",
  };
}

type ToolTimelineEvent = Extract<TimelineEvent, {
  type: "tool_preparing" | "tool_parameters_streaming" | "tool_prepared" | "tool_started" | "tool_updated" | "tool_finished";
}>;

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.flatMap((part) => isRecord(part) && part.type === "text" && typeof part.text === "string"
    ? [part.text]
    : []).join("\n");
}

function extractToolResult(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  const allText = content.every((part) => isRecord(part) && part.type === "text" && typeof part.text === "string");
  return allText ? content.map((part) => (part as { text: string }).text).join("\n") : content;
}

function normalizeToolPayload(payload: unknown): { value: unknown; details?: unknown } {
  if (!isRecord(payload) || !("content" in payload)) {
    return { value: payload };
  }
  return {
    value: extractToolResult(payload.content),
    ...(payload.details !== undefined ? { details: payload.details } : {}),
  };
}

function createId(prefix: string, entries: ConversationEntry[]): string {
  const blockCount = entries.reduce((count, entry) => count + (entry.type === "agent" ? entry.blocks.length : 0), 0);
  return `${prefix}-${entries.length}-${blockCount}`;
}

function isBranchNavigation(value: unknown): value is { index: number; count: number; previousEntryId?: string; nextEntryId?: string; previousNavigationEntryId?: string; nextNavigationEntryId?: string } {
  return isRecord(value)
    && typeof value.index === "number"
    && typeof value.count === "number"
    && Number.isInteger(value.index)
    && Number.isInteger(value.count)
    && value.index >= 0
    && value.count > 0
    && (value.previousEntryId === undefined || typeof value.previousEntryId === "string")
    && (value.nextEntryId === undefined || typeof value.nextEntryId === "string")
    && (value.previousNavigationEntryId === undefined || typeof value.previousNavigationEntryId === "string")
    && (value.nextNavigationEntryId === undefined || typeof value.nextNavigationEntryId === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
