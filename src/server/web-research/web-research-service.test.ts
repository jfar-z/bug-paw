import { describe, expect, it } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { WebResearchService } from "./web-research-service";

function createService(overrides: Partial<ConstructorParameters<typeof WebResearchService>[0]> = {}) {
  return new WebResearchService({
    readConfig: async () => ({ revision: "r1", config: { ...DEFAULT_WEB_RESEARCH_CONFIG, enabled: true, maxTextLength: 1_000 } }),
    searchSearxng: async () => ({ results: [] }),
    fetchText: async () => ({ finalUrl: "https://example.com/article", contentType: "text/html", body: "<main>正文</main>" }),
    extract: async () => ({ title: "文章", content: "正文", published: "2026-08-08" }),
    ...overrides,
  });
}

describe("联网搜索服务", () => {
  it("规范化 URL、合并搜索引擎并去除重复结果", async () => {
    const service = createService({
      searchSearxng: async () => ({ results: [
        { title: "文档", url: "https://Example.com:443/docs#intro", content: "摘要一", engine: "brave", publishedDate: "2026-08-10" },
        { title: "文档副本", url: "https://example.com/docs", content: "摘要二", engine: "bing", publishedDate: "invalid" },
      ] }),
    });

    await expect(service.search({ query: "BugPaw", count: 2 })).resolves.toEqual({
      data: {
        query: "BugPaw",
        results: [{
          rank: 1,
          title: "文档",
          url: "https://example.com/docs",
          hostname: "example.com",
          snippet: "摘要一",
          sourceEngines: ["brave", "bing"],
          publishedAt: "2026-08-10",
        }],
      },
      metadata: { resultCount: 1, duplicatesRemoved: 1, truncated: false },
      warnings: [],
    });
  });

  it("读取 HTML 文章时返回正文完整性与不可信标记", async () => {
    const service = createService();

    const result = await service.read({ url: "https://example.com/requested" });

    expect(result.data).toMatchObject({
      requestedUrl: "https://example.com/requested",
      finalUrl: "https://example.com/article",
      title: "文章",
      hostname: "example.com",
      text: "正文",
      publishedAt: "2026-08-08",
      contentType: "text/html",
      extractionMode: "article",
      fetchedAt: expect.any(String),
    });
    expect(result.metadata).toEqual({ truncated: false, contentCharacters: 2, returnedCharacters: 2, untrustedContent: true });
    expect(result.warnings).toEqual([]);
  });

  it("直接读取纯文本而不依赖文章提取", async () => {
    const service = createService({
      fetchText: async () => ({ finalUrl: "https://example.com/plain", contentType: "text/plain", body: "纯文本正文" }),
      extract: async () => { throw new Error("纯文本不应提取文章"); },
    });

    const result = await service.read({ url: "https://example.com/plain" });

    expect(result.data).toMatchObject({ text: "纯文本正文", extractionMode: "plain_text", contentType: "text/plain" });
    expect(result.warnings).toEqual([]);
  });

  it("文章提取无正文时降级清理 HTML 并返回警告", async () => {
    const service = createService({
      fetchText: async () => ({ finalUrl: "https://example.com/fallback", contentType: "text/html", body: "<main>降级正文</main><script>evil()</script>" }),
      extract: async () => ({ title: "", content: "" }),
    });

    const result = await service.read({ url: "https://example.com/fallback" });

    expect(result.data).toMatchObject({ text: "降级正文", extractionMode: "html_fallback" });
    expect(result.warnings).toEqual([{ code: "ARTICLE_EXTRACTION_FALLBACK", message: "文章正文提取失败，已降级为 HTML 文本" }]);
  });

  it("按配置与请求上限截断并保留原始字符数", async () => {
    const service = createService({
      extract: async () => ({ title: "长文", content: "1234567890" }),
    });

    const result = await service.read({ url: "https://example.com/long", maxCharacters: 4 });

    expect(result.data.text).toBe("1234");
    expect(result.metadata).toEqual({ truncated: true, contentCharacters: 10, returnedCharacters: 4, untrustedContent: true });
  });
});
