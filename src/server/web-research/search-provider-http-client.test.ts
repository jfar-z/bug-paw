import { describe, expect, it } from "vitest";

import { SearchProviderHttpClient, SearchProviderHttpError } from "./search-provider-http-client";

describe("搜索 Provider HTTP 客户端", () => {
  it("发送 JSON 请求且只返回解析后的响应", async () => {
    const requests: unknown[] = [];
    const client = new SearchProviderHttpClient(async (input) => {
      requests.push(input);
      return { status: 200, headers: {}, body: '{"ok":true}' };
    });

    await expect(client.requestJson({
      url: "https://api.example.com/search",
      method: "POST",
      headers: { authorization: "Bearer secret" },
      body: { query: "BugPaw" },
      timeoutMs: 5_000,
      egressProfile: { id: "direct", label: "直接访问", kind: "direct" },
    })).resolves.toEqual({ ok: true });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [401, "authentication", false],
    [403, "authentication", false],
    [429, "rate_limited", true],
    [500, "upstream_error", true],
  ] as const)("把 HTTP %s 映射为稳定失败而不包含正文", async (status, category, retryable) => {
    const client = new SearchProviderHttpClient(async () => {
      const headers: Record<string, string> = status === 429 ? { "retry-after": "3" } : {};
      return { status, headers, body: "private upstream detail" };
    });

    const error = await client.requestJson({
      url: "https://api.example.com/search",
      method: "GET",
      headers: { authorization: "Bearer secret" },
      timeoutMs: 5_000,
      egressProfile: { id: "direct", label: "直接访问", kind: "direct" },
    }).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(SearchProviderHttpError);
    expect(error).toMatchObject({ category, retryable, ...(status === 429 ? { retryAfterMs: 3_000 } : {}) });
    expect(JSON.stringify(error)).not.toContain("private upstream detail");
    expect(JSON.stringify(error)).not.toContain("secret");
  });

  it("把超时和非法 JSON 映射为脱敏稳定失败", async () => {
    const timeoutClient = new SearchProviderHttpClient(async () => { throw new DOMException("private timeout", "TimeoutError"); });
    const invalidClient = new SearchProviderHttpClient(async () => ({ status: 200, headers: {}, body: "not-json private" }));
    const input = { url: "https://api.example.com", method: "GET" as const, headers: {}, timeoutMs: 1_000, egressProfile: { id: "direct" as const, label: "直接访问", kind: "direct" as const } };

    await expect(timeoutClient.requestJson(input)).rejects.toMatchObject({ category: "timeout", retryable: true });
    await expect(invalidClient.requestJson(input)).rejects.toMatchObject({ category: "upstream_error", retryable: true });
  });
});
