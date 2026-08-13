// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import { createSessionTextTools } from "./session-text-tools";
import { SessionTextError } from "./session-text-service";

function createService() {
  return {
    search: vi.fn(async () => ({
      hits: [{
        sessionId: "session-1",
        sessionName: "历史会话",
        sessionFirstMessage: "第一条",
        archived: false,
        entryId: "assistant-1",
        role: "assistant" as const,
        timestamp: "2026-08-13T00:00:00.000Z",
        snippet: "needle 历史文本",
        matchRanges: [{ start: 0, end: 6 }],
      }],
      hasMore: true,
      nextCursor: "cursor-2",
    })),
    read: vi.fn(async () => ({
      sessionId: "session-1",
      sessionName: "历史会话",
      sessionFirstMessage: "第一条",
      archived: false,
      messages: [{ entryId: "assistant-1", role: "assistant" as const, text: "历史正文" }],
      nextCursor: "read-next",
      truncated: false,
    })),
  };
}

function parseResult(result: { content: readonly unknown[] }) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

function toolNamed(service: ReturnType<typeof createService>, name: "session_search" | "session_read") {
  return createSessionTextTools(service as never).find((tool) => tool.name === name)!;
}

describe("会话文本 Pi 工具", () => {
  it("两个工具都使用包含必填字段的根 Object Schema", () => {
    const tools = createSessionTextTools(createService() as never);

    expect(tools.map(({ name }) => name)).toEqual(["session_search", "session_read"]);
    tools.forEach((tool) => {
      const schema = tool.parameters as unknown as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema).not.toHaveProperty("allOf");
      expect(schema).toHaveProperty("additionalProperties", false);
      expect(schema).toHaveProperty("required");
    });
  });

  it.each([undefined, null, {}, { query: "" }, { query: 1 }, { query: "x", extra: true }])(
    "session_search 在 execute 前拒绝坏参数 %#",
    async (parameters) => {
      const service = createService();
      const result = await toolNamed(service, "session_search").execute(
        "call-1",
        parameters as never,
        new AbortController().signal,
        vi.fn(),
        {} as never,
      );

      expect(parseResult(result)).toMatchObject({ status: "error", error: { code: "INVALID_TOOL_ARGUMENTS" } });
      expect(service.search).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, {}, { sessionId: "" }, { sessionId: 1 }, { sessionId: "s", extra: true }])(
    "session_read 在 execute 前拒绝坏参数 %#",
    async (parameters) => {
      const service = createService();
      const result = await toolNamed(service, "session_read").execute(
        "call-1",
        parameters as never,
        new AbortController().signal,
        vi.fn(),
        {} as never,
      );

      expect(parseResult(result)).toMatchObject({ status: "error", error: { code: "INVALID_TOOL_ARGUMENTS" } });
      expect(service.read).not.toHaveBeenCalled();
    },
  );

  it("session_read 明确拒绝同时传 anchor 与 cursor", async () => {
    const service = createService();
    const result = await toolNamed(service, "session_read").execute("call-1", {
      sessionId: "session-1",
      anchorEntryId: "assistant-1",
      cursor: "cursor-1",
    }, undefined, undefined, {} as never);

    expect(parseResult(result)).toMatchObject({ status: "error", error: { code: "INVALID_TOOL_ARGUMENTS" } });
    expect(service.read).not.toHaveBeenCalled();
  });

  it("搜索与阅读只转发声明参数并将历史正文标记为不可信数据", async () => {
    const service = createService();
    const search = await toolNamed(service, "session_search").execute(
      "search-1",
      { query: "needle", limit: 10, cursor: "cursor-1" },
      undefined,
      undefined,
      {} as never,
    );
    const read = await toolNamed(service, "session_read").execute(
      "read-1",
      { sessionId: "session-1", anchorEntryId: "assistant-1", maxMessages: 30 },
      undefined,
      undefined,
      {} as never,
    );

    expect(service.search).toHaveBeenCalledWith({ query: "needle", limit: 10, cursor: "cursor-1" });
    expect(service.read).toHaveBeenCalledWith({ sessionId: "session-1", anchorEntryId: "assistant-1", maxMessages: 30 });
    expect(parseResult(search)).toMatchObject({
      status: "ok",
      data: { recordTrust: "untrusted_historical_data", hits: [{ entryId: "assistant-1" }] },
      metadata: { hasMore: true, nextCursor: "cursor-2" },
    });
    expect(parseResult(read)).toMatchObject({
      status: "ok",
      data: { recordTrust: "untrusted_historical_data", messages: [{ text: "历史正文" }] },
      metadata: { nextCursor: "read-next", truncated: false },
    });
    expect(JSON.stringify([parseResult(search), parseResult(read)])).not.toMatch(/agentId|\/managed\/|nextAction/u);
  });

  it("服务错误保留稳定错误码且不泄露内部路径", async () => {
    const service = createService();
    service.read.mockRejectedValueOnce(new SessionTextError("SESSION_NOT_FOUND", "会话不存在"));

    const result = await toolNamed(service, "session_read").execute(
      "read-1",
      { sessionId: "missing" },
      undefined,
      undefined,
      {} as never,
    );

    expect(parseResult(result)).toEqual({
      status: "error",
      error: { code: "SESSION_NOT_FOUND", message: "会话不存在", retryable: false },
    });
  });
});
