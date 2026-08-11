import { describe, expect, it } from "vitest";

import { TavilySearchProvider } from "./tavily-search-provider";

describe("Tavily Search Provider", () => {
  it("固定基础搜索参数并只映射 results", async () => {
    const requests: Array<{ body?: unknown }> = [];
    const provider = new TavilySearchProvider("tavily-main", "tvly-secret", 10_000, { id: "direct", label: "直接访问", kind: "direct" }, {
      requestJson: async (input) => {
        requests.push(input);
        return {
          answer: "厂商生成答案",
          results: [{ title: "官方文档", url: "https://docs.example.com", content: "相关摘要", published_date: "2026-08-11", score: 0.9 }],
        };
      },
    });

    const result = await provider.search({ query: "BugPaw", count: 4, site: "docs.example.com", language: "zh", timeRange: "week" });

    expect(requests[0]?.body).toEqual({
      query: "BugPaw",
      max_results: 4,
      search_depth: "basic",
      include_answer: false,
      include_raw_content: false,
      auto_parameters: false,
      include_domains: ["docs.example.com"],
      time_range: "week",
    });
    expect(result.results).toEqual([{ title: "官方文档", url: "https://docs.example.com", snippet: "相关摘要", source: "docs.example.com", publishedAt: "2026-08-11" }]);
    expect(JSON.stringify(result)).not.toContain("厂商生成答案");
  });
});
