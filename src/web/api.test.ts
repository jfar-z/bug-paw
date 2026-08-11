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

describe("联网搜索 Provider API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("编码实例 ID 并使用独立版本发送凭证和删除请求", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      credentialRevision: "credential-2",
      status: { providerId: "bocha/main", type: "api_key", configured: true },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.setWebResearchProviderCredential("bocha/main", "credential-1", "secret");
    await api.deleteWebResearchProvider("bocha/main", "config-1", "credential-2");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/capabilities/web-research/providers/bocha%2Fmain/credential", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: "credential-1", apiKey: "secret" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/capabilities/web-research/providers/bocha%2Fmain", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ configRevision: "config-1", credentialRevision: "credential-2" }),
    }));
  });
});
