import { describe, expect, it } from "vitest";

import { BochaSearchProvider } from "./bocha-search-provider";

describe("博查 Web Search Provider", () => {
  it("只请求 Web Search 并映射网页候选结果", async () => {
    const requests: Array<{ url: string; body?: unknown; headers: Record<string, string> }> = [];
    const provider = new BochaSearchProvider("bocha-main", "bocha-secret", 8_000, { id: "direct", label: "直接访问", kind: "direct" }, {
      requestJson: async (input) => {
        requests.push(input);
        return {
          data: {
            webPages: { value: [{ name: "示例标题", url: "https://example.com/article", snippet: "示例摘要", siteName: "示例站点", datePublished: "2026-08-11" }] },
            answer: "不应进入结果",
            followUpQuestions: ["不应进入结果"],
          },
        };
      },
    });

    const result = await provider.search({ query: "BugPaw", count: 5, timeRange: "month" });

    expect(requests[0]).toMatchObject({
      url: "https://api.bochaai.com/v1/web-search",
      headers: { authorization: "Bearer bocha-secret" },
      body: { query: "BugPaw", count: 5, freshness: "oneMonth", summary: true },
    });
    expect(result).toEqual({
      health: "healthy",
      results: [{ title: "示例标题", url: "https://example.com/article", snippet: "示例摘要", source: "示例站点", publishedAt: "2026-08-11" }],
      failures: [],
    });
    expect(JSON.stringify(result)).not.toContain("不应进入结果");
  });

  it("把 HTTP 失败转成实例级 unavailable", async () => {
    const provider = new BochaSearchProvider("bocha-main", "secret", 8_000, { id: "direct", label: "直接访问", kind: "direct" }, {
      requestJson: async () => { throw Object.assign(new Error("脱敏错误"), { category: "rate_limited", retryable: true, retryAfterMs: 2_000 }); },
    });

    await expect(provider.search({ query: "BugPaw", count: 5 })).resolves.toEqual({
      health: "unavailable",
      results: [],
      failures: [{ provider: "bocha-main", category: "rate_limited", retryable: true, retryAfterMs: 2_000 }],
    });
  });
});
