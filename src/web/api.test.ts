import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api } from "./api";

describe("知识库 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("使用编码后的知识库 ID 发起删除请求", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteKnowledgeBase("base/a");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/knowledge-bases/base%2Fa",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });

  it("保留统一错误文档中的稳定错误码和请求标识", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "VERSION_CONFLICT",
        message: "版本冲突",
        requestId: "request-example",
        details: { expectedRevision: "2" },
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } })));

    const error = await api.getStatus().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "VERSION_CONFLICT",
      status: 409,
      requestId: "request-example",
      details: { expectedRevision: "2" },
    });
  });

  it("服务返回非 JSON 内容时抛出稳定协议错误", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", {
      status: 502,
      headers: { "X-Request-Id": "request-invalid" },
    })));

    await expect(api.getStatus()).rejects.toMatchObject({
      code: "API_RESPONSE_INVALID",
      status: 502,
      requestId: "request-invalid",
    });
  });
});

describe("会话批量 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("发送批量预览与带指纹执行请求", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        action: "delete" | "archive" | "restore";
        target: { mode: "selected"; sessionIds: string[] } | { mode: "all_archived"; agentId: string };
      };
      return new Response(JSON.stringify({
        action: body.action,
        target: body.target,
        sessionCount: body.target.mode === "selected" ? body.target.sessionIds.length : 2,
        tasks: [],
        fingerprint: "fingerprint-1",
        affectedTaskCount: 0,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const target = { mode: "all_archived" as const, agentId: "agent-1" };
    await api.previewSessionBulk("delete", target);
    await api.executeSessionBulk("delete", target, "fingerprint-1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/sessions/bulk/preview", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "delete", target }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/sessions/bulk", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "delete", target, fingerprint: "fingerprint-1" }),
    }));
  });

  it("单会话删除确认使用停用绑定任务参数", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteSession("session/a", true);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/session%2Fa?confirmBoundTasks=true",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("会话文本检索 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("编码搜索参数并保留取消信号", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ hits: [], hasMore: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.searchSessions("agent/a", { query: "中文 & text", cursor: "cursor/1" }, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/search?agentId=agent%2Fa&query=%E4%B8%AD%E6%96%87%20%26%20text&cursor=cursor%2F1",
      expect.objectContaining({ credentials: "same-origin", signal: controller.signal }),
    );
  });

  it("编码目标窗口和向后分页参数", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      sessionId: "session/a",
      messages: [],
      history: { branchToken: "branch/a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.loadSessionHistoryTarget("session/a", "assistant/10", "branch/a", controller.signal);
    await api.loadSessionHistoryAfter("session/a", "assistant/20", "branch/a", controller.signal);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/sessions/session%2Fa/history-window?entryId=assistant%2F10&branch=branch%2Fa",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/sessions/session%2Fa/history?after=assistant%2F20&branch=branch%2Fa",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("会话置顶 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("使用编码后的会话 ID 发起置顶与取消置顶请求", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.pinSession("session/a");
    await api.unpinSession("session/a");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/v1/sessions/session%2Fa/pin",
      expect.objectContaining({ method: "PUT" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/v1/sessions/session%2Fa/pin",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("会话思考深度 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("使用编码后的会话 ID 写入规范思考深度", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.setThinkingLevel("session/a", "low");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/session%2Fa/thinking-level",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ thinkingLevel: "low" }) }),
    );
  });
});

describe("会话提问 API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("提交带版本号的结构化答案并返回下一次运行", async () => {
    const run = {
      runId: "run-next",
      sessionId: "session/a",
      status: "queued",
      startedAt: "2026-08-13T08:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(run), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.submitQuestionAnswers("session/a", "question/1", {
      version: 2,
      answers: [{ questionId: "q-1", kind: "options", optionIds: ["o-2"] }],
    });

    expect(result).toEqual(run);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/sessions/session%2Fa/questions/question%2F1/answers",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          version: 2,
          answers: [{ questionId: "q-1", kind: "options", optionIds: ["o-2"] }],
        }),
      }),
    );
  });
});

describe("联网搜索 Provider API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("按作用域发送全局、渠道、排序和删除请求", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = { id: "bocha/main", name: "博查", type: "bocha" as const, connectionMode: "official" as const, enabled: false, timeoutMs: 8_000 };
    await api.updateWebResearchGlobal("config-1", {
      enabled: false,
      webRead: { egressProfileId: "direct", timeoutMs: 10_000 },
      maxResults: 5,
      maxTextLength: 20_000,
      maxRedirects: 3,
      maxResponseBytes: 2_097_152,
      httpsOnly: true,
      allowedDomains: [],
      allowedContentTypes: ["text/html"],
    });
    await api.createWebResearchProvider({ configRevision: "config-1", credentialRevision: "credential-1", provider, apiKey: "secret" });
    await api.updateWebResearchProvider("bocha/main", {
      configRevision: "config-2",
      credentialRevision: "credential-2",
      provider,
      credential: { action: "keep" },
    });
    await api.reorderWebResearchProviders("config-3", ["bocha/main"]);
    await api.deleteWebResearchProvider("bocha/main", "config-1", "credential-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/capabilities/web-research/global", expect.objectContaining({ method: "PATCH" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/capabilities/web-research/providers", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ configRevision: "config-1", credentialRevision: "credential-1", provider, apiKey: "secret" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/capabilities/web-research/providers/bocha%2Fmain", expect.objectContaining({ method: "PATCH" }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/capabilities/web-research/providers/order", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: "config-3", providerIds: ["bocha/main"] }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/v1/capabilities/web-research/providers/bocha%2Fmain", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ configRevision: "config-1", credentialRevision: "credential-2" }),
    }));
  });
});
