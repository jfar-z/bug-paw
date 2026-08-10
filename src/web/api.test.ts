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
