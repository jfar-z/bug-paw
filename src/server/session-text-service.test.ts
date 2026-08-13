// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SESSION_TEXT_CURSOR_TTL_MS,
  SessionTextError,
  SessionTextService,
  type SessionTextSource,
  type SessionTextSourceSession,
} from "./session-text-service";

function sourceSession(id: string, modified: string): SessionTextSourceSession {
  return {
    id,
    path: `/managed/${id}.jsonl`,
    name: `会话 ${id}`,
    firstMessage: `首条 ${id}`,
    created: "2026-08-13T00:00:00.000Z",
    modified,
    messageCount: 1,
  };
}

function createSource(input: {
  sessions: SessionTextSourceSession[];
  persisted?: Record<string, unknown[]>;
  live?: Record<string, unknown[] | undefined>;
  archived?: string[];
}): SessionTextSource {
  return {
    listSessions: async () => input.sessions,
    readPersistedBranch: async (session) => input.persisted?.[session.id] ?? [],
    readLiveBranch: (sessionId) => input.live?.[sessionId],
    isArchived: async (sessionId) => input.archived?.includes(sessionId) ?? false,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionTextService 搜索", () => {
  it("搜索普通与归档会话并优先使用实时活动分支", async () => {
    const normal = sourceSession("normal", "2026-08-13T01:00:00.000Z");
    const archived = sourceSession("archived", "2026-08-13T02:00:00.000Z");
    const service = new SessionTextService("agent-a", createSource({
      sessions: [normal, archived],
      archived: ["archived"],
      persisted: {
        normal: [
          { role: "user", content: "Needle 普通", __piEntryId: "user-normal", timestamp: "2026-08-13T01:00:00.000Z" },
          { role: "toolResult", content: "Needle 工具", __piEntryId: "tool-normal" },
        ],
        archived: [{ role: "assistant", content: [{ type: "text", text: "Needle 旧叶" }], __piEntryId: "assistant-old" }],
      },
      live: {
        archived: [{
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Needle 思考" },
            { type: "text", text: "Needle 归档" },
          ],
          __piEntryId: "assistant-live",
          timestamp: "2026-08-13T02:00:00.000Z",
        }],
      },
    }));

    const page = await service.search({ query: "needle", limit: 20 });

    expect(page).toMatchObject({ hasMore: false });
    expect(page.hits.map(({ sessionId, entryId, archived: isArchived }) => ({ sessionId, entryId, isArchived })))
      .toEqual([
        { sessionId: "archived", entryId: "assistant-live", isArchived: true },
        { sessionId: "normal", entryId: "user-normal", isArchived: false },
      ]);
    expect(page.hits.flatMap(({ snippet }) => snippet)).not.toContain("工具");
    expect(page.hits.flatMap(({ snippet }) => snippet)).not.toContain("旧叶");
  });

  it("按消息时间稳定分页并拒绝篡改、查询不一致和过期游标", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T03:00:00.000Z"));
    const session = sourceSession("session-a", "2026-08-13T03:00:00.000Z");
    const service = new SessionTextService("agent-a", createSource({
      sessions: [session],
      persisted: {
        "session-a": [1, 2, 3].map((number) => ({
          role: "user",
          content: `needle-${number}`,
          __piEntryId: `user-${number}`,
          timestamp: `2026-08-13T0${number}:00:00.000Z`,
        })),
      },
    }));

    const first = await service.search({ query: "needle", limit: 2 });
    expect(first.hits.map(({ entryId }) => entryId)).toEqual(["user-3", "user-2"]);
    expect(first).toMatchObject({ hasMore: true });
    expect(first.nextCursor).toBeTruthy();
    expect(first.nextCursor).not.toContain("needle");
    expect((await service.search({ query: "needle", limit: 2, cursor: first.nextCursor })).hits)
      .toMatchObject([{ entryId: "user-1" }]);

    await expect(service.search({ query: "other", cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "SESSION_SEARCH_CURSOR_INVALID" });
    await expect(service.search({ query: "needle", cursor: "tampered" }))
      .rejects.toMatchObject({ code: "SESSION_SEARCH_CURSOR_INVALID" });

    vi.advanceTimersByTime(SESSION_TEXT_CURSOR_TTL_MS + 1);
    await expect(service.search({ query: "needle", cursor: first.nextCursor }))
      .rejects.toMatchObject({ code: "SESSION_SEARCH_CURSOR_INVALID" });
  });

  it("缓存按 session 指纹复用并在失效或删除后更新", async () => {
    const session = sourceSession("session-a", "2026-08-13T01:00:00.000Z");
    const input = {
      sessions: [session],
      persisted: {
        "session-a": [{ role: "user", content: "first", __piEntryId: "user-1" }],
      },
    };
    const source = createSource(input);
    const readPersistedBranch = vi.spyOn(source, "readPersistedBranch");
    const service = new SessionTextService("agent-a", source);

    expect((await service.search({ query: "first" })).hits).toHaveLength(1);
    expect((await service.search({ query: "first" })).hits).toHaveLength(1);
    expect(readPersistedBranch).toHaveBeenCalledTimes(1);

    input.persisted["session-a"] = [{ role: "user", content: "second", __piEntryId: "user-2" }];
    service.invalidate("session-a");
    expect((await service.search({ query: "second" })).hits).toHaveLength(1);
    expect(readPersistedBranch).toHaveBeenCalledTimes(2);

    input.sessions.splice(0, 1);
    expect((await service.search({ query: "second" })).hits).toHaveLength(0);
  });
});

describe("SessionTextService 阅读", () => {
  it("读取最近文本、锚点窗口和两个方向的继续游标", async () => {
    const session = sourceSession("session-a", "2026-08-13T03:00:00.000Z");
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: index % 2 === 0 ? `text-${index + 1}` : [{ type: "text", text: `text-${index + 1}` }],
      __piEntryId: `entry-${index + 1}`,
    }));
    const service = new SessionTextService("agent-a", createSource({
      sessions: [session],
      persisted: { "session-a": messages },
    }));

    const latest = await service.read({ sessionId: "session-a", maxMessages: 3 });
    expect(latest.messages.map(({ entryId }) => entryId)).toEqual(["entry-6", "entry-7", "entry-8"]);
    expect(latest.previousCursor).toBeTruthy();
    expect(latest.nextCursor).toBeUndefined();

    const around = await service.read({ sessionId: "session-a", anchorEntryId: "entry-4", maxMessages: 3 });
    expect(around.messages.map(({ entryId }) => entryId)).toEqual(["entry-3", "entry-4", "entry-5"]);
    expect(around.previousCursor).toBeTruthy();
    expect(around.nextCursor).toBeTruthy();
    expect((await service.read({ sessionId: "session-a", cursor: around.previousCursor })).messages.map(({ entryId }) => entryId))
      .toEqual(["entry-1", "entry-2"]);
    expect((await service.read({ sessionId: "session-a", cursor: around.nextCursor })).messages.map(({ entryId }) => entryId))
      .toEqual(["entry-6", "entry-7", "entry-8"]);
  });

  it("限制总字符数并对越权形态统一返回稳定错误", async () => {
    const session = sourceSession("session-a", "2026-08-13T03:00:00.000Z");
    const service = new SessionTextService("agent-a", createSource({
      sessions: [session],
      persisted: {
        "session-a": [{ role: "user", content: "长".repeat(25_000), __piEntryId: "entry-long" }],
      },
    }));

    const page = await service.read({ sessionId: "session-a" });
    expect(page.truncated).toBe(true);
    expect(page.messages[0]?.text.length).toBe(20_000);
    await expect(service.read({ sessionId: "missing" }))
      .rejects.toEqual(expect.objectContaining({ code: "SESSION_NOT_FOUND" }));
    await expect(service.read({ sessionId: "session-a", anchorEntryId: "missing" }))
      .rejects.toEqual(expect.objectContaining({ code: "SESSION_ENTRY_NOT_FOUND" }));
    await expect(service.read({ sessionId: "session-a", anchorEntryId: "entry-long", cursor: "bad" }))
      .rejects.toBeInstanceOf(SessionTextError);
  });
});
