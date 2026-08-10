import { describe, expect, it } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { WebResearchService } from "./web-research-service";

describe("联网搜索服务", () => {
  it("将 SearXNG 结果归一化为可引用来源", async () => {
    const service = new WebResearchService({
      readConfig: async () => ({ revision: "r1", config: { ...DEFAULT_WEB_RESEARCH_CONFIG, enabled: true } }),
      searchSearxng: async () => ({ results: [{ title: "BugPaw", url: "https://example.com/docs", content: "产品介绍", engine: "brave" }] }),
      fetchText: async () => ({ finalUrl: "https://example.com", contentType: "text/html", body: "<main>正文</main>" }),
      extract: async () => ({ title: "文章", content: "正文", published: "2026-08-08" }),
    });

    await expect(service.search({ query: "BugPaw", count: 2 })).resolves.toEqual({
      results: [{ title: "BugPaw", url: "https://example.com/docs", snippet: "产品介绍", source: "brave" }],
    });
  });

  it("读取页面时保留最终来源并截断正文", async () => {
    const service = new WebResearchService({
      readConfig: async () => ({ revision: "r1", config: { ...DEFAULT_WEB_RESEARCH_CONFIG, enabled: true, maxTextLength: 1_000 } }),
      searchSearxng: async () => ({ results: [] }),
      fetchText: async () => ({ finalUrl: "https://example.com/article", contentType: "text/html", body: "<main>正文</main>" }),
      extract: async () => ({ title: "文章", content: "内容较长", published: "2026-08-08" }),
    });

    await expect(service.open({ url: "https://example.com/article" })).resolves.toEqual({
      title: "文章", finalUrl: "https://example.com/article", text: "内容较长", published: "2026-08-08", sourceUrl: "https://example.com/article",
    });
  });
});
