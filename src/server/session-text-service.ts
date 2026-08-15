import { randomUUID } from "node:crypto";

import {
  buildSessionTextSnippet,
  extractVisibleSessionText,
  SESSION_TEXT_READ_DEFAULT_MESSAGES,
  SESSION_TEXT_READ_MAX_CHARACTERS,
  type SessionTextMessage,
  type SessionTextListItem,
  type SessionTextSearchHit,
} from "../shared/session-text-search";
import type {
  SessionTextListPage,
  SessionTextListRequest,
  SessionTextReadPage,
  SessionTextReadRequest,
  SessionTextSearchPage,
  SessionTextSearchRequest,
} from "../shared/session-text-search";

export const SESSION_TEXT_CURSOR_TTL_MS = 10 * 60 * 1_000;
export const SESSION_TEXT_CURSOR_MAX_ENTRIES = 2_000;

export type SessionTextErrorCode =
  | "SESSION_LIST_LIMIT_INVALID"
  | "SESSION_LIST_CURSOR_INVALID"
  | "SESSION_SEARCH_QUERY_INVALID"
  | "SESSION_SEARCH_CURSOR_INVALID"
  | "SESSION_NOT_FOUND"
  | "SESSION_ENTRY_NOT_FOUND"
  | "SESSION_BRANCH_CHANGED"
  | "SESSION_TEXT_LIMIT_EXCEEDED";

/** 会话文本服务对外暴露的稳定领域错误。 */
export class SessionTextError extends Error {
  constructor(readonly code: SessionTextErrorCode, message: string) {
    super(message);
    this.name = "SessionTextError";
  }
}

/** 固定 Agent 作用域内可读取的受管 Session 摘要。 */
export interface SessionTextSourceSession {
  id: string;
  path: string;
  name?: string;
  firstMessage: string;
  created: string;
  modified: string;
  messageCount: number;
}

/** 隔离持久化 Session 与实时 Runtime 的窄读取端口。 */
export interface SessionTextSource {
  listSessions(): Promise<SessionTextSourceSession[]>;
  readPersistedBranch(session: SessionTextSourceSession): Promise<unknown[]>;
  readLiveBranch(sessionId: string): readonly unknown[] | undefined;
  isArchived(sessionId: string): Promise<boolean>;
}

interface CachedSessionText {
  fingerprint: string;
  session: SessionTextSourceSession;
  archived: boolean;
  messages: SessionTextMessage[];
  revision: string;
}

interface SearchCursorState {
  kind: "search";
  agentId: string;
  query: string;
  offset: number;
  limit: number;
  revision: string;
}

interface ListCursorState {
  kind: "list";
  agentId: string;
  limit: number;
  modified: string;
  sessionId: string;
}

interface ReadCursorState {
  kind: "read";
  agentId: string;
  sessionId: string;
  direction: "before" | "after";
  boundary: number;
  maxMessages: number;
  revision: string;
}

type CursorState = ListCursorState | SearchCursorState | ReadCursorState;

interface CursorRecord {
  expiresAt: number;
  state: CursorState;
}

/** 为单个 Agent 提供列表、搜索、阅读、缓存和不透明游标。 */
export class SessionTextService {
  private readonly cache = new Map<string, CachedSessionText>();
  private readonly cursors = new Map<string, CursorRecord>();

  constructor(
    private readonly agentId: string,
    private readonly source: SessionTextSource,
  ) {}

  async list(input: SessionTextListRequest): Promise<SessionTextListPage> {
    const limit = validateListLimit(input.limit);
    let boundary: Pick<ListCursorState, "modified" | "sessionId"> | undefined;
    if (input.cursor) {
      const cursor = this.readCursor(input.cursor, invalidListCursor);
      if (cursor.kind !== "list"
        || cursor.agentId !== this.agentId
        || cursor.limit !== limit) {
        throw invalidListCursor();
      }
      boundary = cursor;
    }

    const listed = await this.loadSessionList();
    const remaining = boundary
      ? listed.filter((session) => isAfterListBoundary(session, boundary))
      : listed;
    const sessions = remaining.slice(0, limit);
    const hasMore = remaining.length > sessions.length;
    const last = sessions.at(-1);
    return {
      sessions,
      hasMore,
      ...(hasMore && last ? {
        nextCursor: this.createCursor({
          kind: "list",
          agentId: this.agentId,
          limit,
          modified: last.modified,
          sessionId: last.sessionId,
        }),
      } : {}),
    };
  }

  async search(input: SessionTextSearchRequest): Promise<SessionTextSearchPage> {
    validateQuery(input.query);
    const sessions = await this.loadSessions();
    const hits = buildSearchHits(sessions, input.query);
    const revision = searchRevision(hits);
    let offset = 0;
    let limit = validateSearchLimit(input.limit);
    if (input.cursor) {
      const cursor = this.readCursor(input.cursor);
      if (cursor.kind !== "search"
        || cursor.agentId !== this.agentId
        || cursor.query !== input.query
        || cursor.revision !== revision
        || (input.limit !== undefined && input.limit !== cursor.limit)) {
        throw invalidCursor();
      }
      offset = cursor.offset;
      limit = cursor.limit;
    }

    const pageHits = hits.slice(offset, offset + limit);
    const nextOffset = offset + pageHits.length;
    const hasMore = nextOffset < hits.length;
    return {
      hits: pageHits,
      hasMore,
      ...(hasMore ? {
        nextCursor: this.createCursor({
          kind: "search",
          agentId: this.agentId,
          query: input.query,
          offset: nextOffset,
          limit,
          revision,
        }),
      } : {}),
    };
  }

  async read(input: SessionTextReadRequest): Promise<SessionTextReadPage> {
    if (!input.sessionId || (input.anchorEntryId && input.cursor)) {
      throw new SessionTextError("SESSION_SEARCH_CURSOR_INVALID", "会话阅读参数无效");
    }
    const sessions = await this.loadSessions();
    const session = sessions.find(({ session: candidate }) => candidate.id === input.sessionId);
    if (!session) throw new SessionTextError("SESSION_NOT_FOUND", "会话不存在");

    let maxMessages = validateReadLimit(input.maxMessages);
    let start: number;
    let end: number;
    if (input.cursor) {
      const cursor = this.readCursor(input.cursor);
      if (cursor.kind !== "read"
        || cursor.agentId !== this.agentId
        || cursor.sessionId !== input.sessionId
        || cursor.revision !== session.revision
        || (input.maxMessages !== undefined && input.maxMessages !== cursor.maxMessages)) {
        throw invalidCursor();
      }
      maxMessages = cursor.maxMessages;
      if (cursor.boundary < 0 || cursor.boundary > session.messages.length) {
        throw new SessionTextError("SESSION_BRANCH_CHANGED", "会话分支已变化");
      }
      if (cursor.direction === "before") {
        end = cursor.boundary;
        start = Math.max(0, end - maxMessages);
      } else {
        start = cursor.boundary;
        end = Math.min(session.messages.length, start + maxMessages);
      }
    } else if (input.anchorEntryId) {
      const anchorIndex = session.messages.findIndex(({ entryId }) => entryId === input.anchorEntryId);
      if (anchorIndex < 0) throw new SessionTextError("SESSION_ENTRY_NOT_FOUND", "会话记录不存在");
      start = Math.max(0, anchorIndex - Math.floor((maxMessages - 1) / 2));
      end = Math.min(session.messages.length, start + maxMessages);
      start = Math.max(0, end - maxMessages);
    } else {
      end = session.messages.length;
      start = Math.max(0, end - maxMessages);
    }

    const bounded = boundTextCharacters(session.messages.slice(start, end));
    const deliveredEnd = Math.min(end, start + bounded.messages.length);
    return {
      sessionId: session.session.id,
      ...(session.session.name ? { sessionName: session.session.name } : {}),
      sessionFirstMessage: session.session.firstMessage,
      archived: session.archived,
      messages: bounded.messages,
      truncated: bounded.truncated,
      ...(start > 0 ? {
        previousCursor: this.createCursor({
          kind: "read",
          agentId: this.agentId,
          sessionId: session.session.id,
          direction: "before",
          boundary: start,
          maxMessages,
          revision: session.revision,
        }),
      } : {}),
      ...(deliveredEnd < session.messages.length ? {
        nextCursor: this.createCursor({
          kind: "read",
          agentId: this.agentId,
          sessionId: session.session.id,
          direction: "after",
          boundary: deliveredEnd,
          maxMessages,
          revision: session.revision,
        }),
      } : {}),
    };
  }

  invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
    for (const [cursor, record] of this.cursors) {
      // 列表使用稳定边界分页，不应因当前会话正常追加消息而失效。
      if (record.state.kind !== "list") this.cursors.delete(cursor);
    }
  }

  clear(): void {
    this.cache.clear();
    this.cursors.clear();
  }

  private async loadSessions(): Promise<CachedSessionText[]> {
    const listed = await this.source.listSessions();
    const listedIds = new Set(listed.map(({ id }) => id));
    for (const sessionId of this.cache.keys()) {
      if (!listedIds.has(sessionId)) this.cache.delete(sessionId);
    }
    return Promise.all(listed.map(async (session) => {
      const archived = await this.source.isArchived(session.id);
      const live = this.source.readLiveBranch(session.id);
      const hasLiveBranch = live !== undefined;
      const fingerprint = [session.modified, session.messageCount, archived, hasLiveBranch ? "live" : "persisted"].join("\n");
      const cached = this.cache.get(session.id);
      if (cached?.fingerprint === fingerprint) return cached;
      const rawMessages = hasLiveBranch ? [...live] : await this.source.readPersistedBranch(session);
      const messages = rawMessages.flatMap((message) => {
        const visible = extractVisibleSessionText(message);
        return visible ? [{ ...visible, timestamp: visible.timestamp ?? session.modified }] : [];
      });
      const next: CachedSessionText = {
        fingerprint,
        session,
        archived,
        messages,
        revision: messages.map(({ entryId }) => entryId).join("\n"),
      };
      this.cache.set(session.id, next);
      return next;
    }));
  }

  private async loadSessionList(): Promise<SessionTextListItem[]> {
    const listed = await this.source.listSessions();
    const sessions = await Promise.all(listed.map(async (session) => ({
      sessionId: session.id,
      ...(session.name ? { sessionName: session.name } : {}),
      sessionFirstMessage: session.firstMessage,
      created: session.created,
      modified: session.modified,
      messageCount: session.messageCount,
      archived: await this.source.isArchived(session.id),
    })));
    return sessions.sort(compareListedSessions);
  }

  private createCursor(state: CursorState): string {
    this.cleanupCursors();
    while (this.cursors.size >= SESSION_TEXT_CURSOR_MAX_ENTRIES) {
      const oldest = this.cursors.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cursors.delete(oldest);
    }
    let cursor = randomUUID();
    while (this.cursors.has(cursor)) cursor = randomUUID();
    this.cursors.set(cursor, { expiresAt: Date.now() + SESSION_TEXT_CURSOR_TTL_MS, state });
    return cursor;
  }

  private readCursor(cursor: string, errorFactory: () => SessionTextError = invalidCursor): CursorState {
    this.cleanupCursors();
    const record = this.cursors.get(cursor);
    if (!record) throw errorFactory();
    return record.state;
  }

  private cleanupCursors(): void {
    const now = Date.now();
    for (const [cursor, record] of this.cursors) {
      if (record.expiresAt <= now) this.cursors.delete(cursor);
    }
  }
}

function compareListedSessions(left: SessionTextListItem, right: SessionTextListItem): number {
  return right.modified.localeCompare(left.modified) || left.sessionId.localeCompare(right.sessionId);
}

function isAfterListBoundary(
  session: SessionTextListItem,
  boundary: Pick<ListCursorState, "modified" | "sessionId">,
): boolean {
  return session.modified < boundary.modified
    || (session.modified === boundary.modified && session.sessionId > boundary.sessionId);
}

function buildSearchHits(sessions: readonly CachedSessionText[], query: string): SessionTextSearchHit[] {
  return sessions.flatMap(({ session, archived, messages }) => messages.flatMap((message) => {
    const match = buildSessionTextSnippet(message.text, query);
    if (match.matchRanges.length === 0) return [];
    return [{
      sessionId: session.id,
      ...(session.name ? { sessionName: session.name } : {}),
      sessionFirstMessage: session.firstMessage,
      archived,
      entryId: message.entryId,
      role: message.role,
      timestamp: message.timestamp ?? session.modified,
      ...match,
    }];
  })).sort((left, right) => right.timestamp.localeCompare(left.timestamp)
    || left.sessionId.localeCompare(right.sessionId)
    || left.entryId.localeCompare(right.entryId));
}

function searchRevision(hits: readonly SessionTextSearchHit[]): string {
  return hits.map(({ sessionId, entryId, timestamp }) => `${sessionId}\n${entryId}\n${timestamp}`).join("\n\n");
}

function boundTextCharacters(messages: readonly SessionTextMessage[]): { messages: SessionTextMessage[]; truncated: boolean } {
  const bounded: SessionTextMessage[] = [];
  let remaining = SESSION_TEXT_READ_MAX_CHARACTERS;
  let truncated = false;
  for (const message of messages) {
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = safePrefix(message.text, remaining);
    bounded.push(text === message.text ? message : { ...message, text });
    remaining -= text.length;
    if (text !== message.text) {
      truncated = true;
      break;
    }
  }
  return { messages: bounded, truncated };
}

function safePrefix(text: string, maxCharacters: number): string {
  let end = Math.min(text.length, maxCharacters);
  if (end > 0 && end < text.length
    && isHighSurrogate(text.charCodeAt(end - 1))
    && isLowSurrogate(text.charCodeAt(end))) {
    end -= 1;
  }
  return text.slice(0, end);
}

function validateQuery(query: string): void {
  if (typeof query !== "string" || query.length < 1 || query.length > 500) {
    throw new SessionTextError("SESSION_SEARCH_QUERY_INVALID", "搜索内容长度必须为 1 到 500 个字符");
  }
}

function validateListLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
    throw new SessionTextError("SESSION_LIST_LIMIT_INVALID", "会话列表数量必须为 1 到 20 的整数");
  }
  return limit;
}

function validateSearchLimit(limit: number | undefined): number {
  const value = limit ?? 30;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new SessionTextError("SESSION_SEARCH_QUERY_INVALID", "搜索结果数量无效");
  }
  return value;
}

function validateReadLimit(limit: number | undefined): number {
  const value = limit ?? SESSION_TEXT_READ_DEFAULT_MESSAGES;
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw new SessionTextError("SESSION_TEXT_LIMIT_EXCEEDED", "阅读消息数量无效");
  }
  return value;
}

function invalidCursor(): SessionTextError {
  return new SessionTextError("SESSION_SEARCH_CURSOR_INVALID", "会话文本游标无效或已过期");
}

function invalidListCursor(): SessionTextError {
  return new SessionTextError("SESSION_LIST_CURSOR_INVALID", "会话列表游标无效或已过期");
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xD800 && value <= 0xDBFF;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xDC00 && value <= 0xDFFF;
}
