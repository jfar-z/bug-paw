import { describe, expect, it } from "vitest";

import { mapSearxngSearchResponse, SearxngSearchProvider } from "./searxng-search-provider";

describe("SearXNG 搜索 Provider", () => {
  it("无引擎故障时区分健康结果与健康空结果", () => {
    expect(mapSearxngSearchResponse({
      results: [{ title: "文档", url: "https://example.com", content: "摘要", engine: "brave", publishedDate: "2026-08-11" }],
      unresponsive_engines: [],
    })).toEqual({
      health: "healthy",
      results: [{ title: "文档", url: "https://example.com", snippet: "摘要", source: "brave", publishedAt: "2026-08-11" }],
      failures: [],
    });
    expect(mapSearxngSearchResponse({ results: [], unresponsive_engines: [] })).toEqual({
      health: "healthy",
      results: [],
      failures: [],
    });
  });

  it("有结果且部分引擎失败时标记 degraded", () => {
    const result = mapSearxngSearchResponse({
      results: [{ title: "结果", url: "https://example.com", engine: "brave" }],
      unresponsive_engines: [["duckduckgo", "CAPTCHA"]],
    });

    expect(result).toEqual({
      health: "degraded",
      results: [{ title: "结果", url: "https://example.com", snippet: "", source: "brave", publishedAt: null }],
      failures: [{ provider: "duckduckgo", category: "captcha", retryable: true }],
    });
  });

  it("无结果且存在引擎故障时标记 unavailable", () => {
    const result = mapSearxngSearchResponse({
      results: [],
      unresponsive_engines: [
        ["brave", "Suspended: too many requests"],
        ["google cse", "timeout"],
      ],
    });

    expect(result).toEqual({
      health: "unavailable",
      results: [],
      failures: [
        { provider: "brave", category: "rate_limited", retryable: true },
        { provider: "google cse", category: "timeout", retryable: true },
      ],
    });
  });

  it("将鉴权和未知上游错误归一为稳定分类而不保留原始原因", () => {
    const result = mapSearxngSearchResponse({
      results: [],
      unresponsive_engines: [
        ["private-api", "HTTP 401 unauthorized secret-detail"],
        ["other", "internal stack detail"],
      ],
    });

    expect(result.failures).toEqual([
      { provider: "private-api", category: "authentication", retryable: false },
      { provider: "other", category: "upstream_error", retryable: true },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-detail");
    expect(JSON.stringify(result)).not.toContain("internal stack detail");
  });

  it("拒绝缺少结果数组的非法响应", () => {
    expect(() => mapSearxngSearchResponse({ unresponsive_engines: [] })).toThrow("搜索服务返回格式无效");
  });

  it("将畸形引擎故障条目保守归一为上游故障", () => {
    expect(mapSearxngSearchResponse({ results: [], unresponsive_engines: [["brave"], null] })).toEqual({
      health: "unavailable",
      results: [],
      failures: [
        { provider: "searxng", category: "upstream_error", retryable: true },
        { provider: "searxng", category: "upstream_error", retryable: true },
      ],
    });
  });

  it("通过统一接口构造 SearXNG 查询并映射响应", async () => {
    let requestedUrl = "";
    let requestedTimeout = 0;
    const provider = new SearxngSearchProvider("http://search.internal:8080", 4_000, async (url, timeoutMs) => {
      requestedUrl = url.toString();
      requestedTimeout = timeoutMs;
      return { results: [], unresponsive_engines: [] };
    });

    const result = await provider.search({ query: "Bug Paw", count: 5, site: "example.com", language: "zh", timeRange: "month" });

    expect(requestedUrl).toBe("http://search.internal:8080/search?format=json&q=Bug+Paw+site%3Aexample.com&language=zh&time_range=month");
    expect(requestedTimeout).toBe(4_000);
    expect(result).toEqual({ health: "healthy", results: [], failures: [] });
  });

  it("将 SearXNG 请求失败归一为 unavailable 而不是抛出原始错误", async () => {
    const provider = new SearxngSearchProvider("http://search.internal:8080", 4_000, async () => {
      throw new Error("HTTP 429 upstream-private-detail");
    });

    const result = await provider.search({ query: "BugPaw", count: 5 });

    expect(result).toEqual({
      health: "unavailable",
      results: [],
      failures: [{ provider: "searxng", category: "rate_limited", retryable: true }],
    });
    expect(JSON.stringify(result)).not.toContain("upstream-private-detail");
  });
});
