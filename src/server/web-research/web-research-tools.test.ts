import { describe, expect, it } from "vitest";

import { WebResearchSecurityError } from "./safe-web-client";
import { createWebReadTool, createWebSearchTool } from "./web-research-tools";

function parseResult(result: { content: readonly unknown[] }) {
  return JSON.parse((result.content[0] as { type: "text"; text: string }).text);
}

describe("联网搜索 Pi 工具", () => {
  it("web_search 返回统一协议与不可信内容标记", async () => {
    const tool = createWebSearchTool({
      search: async () => ({
        data: { query: "测试", results: [{ rank: 1, title: "标题", url: "https://example.com", hostname: "example.com", snippet: "摘要", sourceEngines: ["brave"], publishedAt: null }] },
        metadata: { resultCount: 1, duplicatesRemoved: 0, truncated: false },
        warnings: [],
      }),
    });

    const result = await tool.execute("call", { query: "测试", count: 1 }, undefined, undefined, {} as never);
    const parsed = parseResult(result);

    expect(tool.name).toBe("web_search");
    expect(parsed).toMatchObject({ status: "ok", data: { results: [{ url: "https://example.com" }] }, metadata: { untrustedContent: true } });
    expect(JSON.stringify(parsed)).not.toMatch(/nextAction|suggestion|recommendation/u);
  });

  it("web_read 将降级或截断正文标记为 partial", async () => {
    const tool = createWebReadTool({
      read: async () => ({
        data: { requestedUrl: "https://example.com", finalUrl: "https://example.com", title: "标题", hostname: "example.com", text: "正文", publishedAt: null, fetchedAt: "2026-08-11T00:00:00.000Z", contentType: "text/html" as const, extractionMode: "html_fallback" as const },
        metadata: { truncated: false, contentCharacters: 2, returnedCharacters: 2, untrustedContent: true as const },
        warnings: [{ code: "ARTICLE_EXTRACTION_FALLBACK", message: "已降级" }],
      }),
    });

    const result = await tool.execute("call", { url: "https://example.com", maxCharacters: 2_000 }, undefined, undefined, {} as never);

    expect(tool.name).toBe("web_read");
    expect(parseResult(result)).toMatchObject({ status: "partial", metadata: { untrustedContent: true }, warnings: [{ code: "ARTICLE_EXTRACTION_FALLBACK" }] });
  });

  it("web_search 无结果返回 empty", async () => {
    const tool = createWebSearchTool({
      search: async () => ({
        data: { query: "无结果", results: [] },
        metadata: { resultCount: 0, duplicatesRemoved: 0, truncated: false },
        warnings: [],
      }),
    });

    const result = await tool.execute("call", { query: "无结果" }, undefined, undefined, {} as never);

    expect(parseResult(result)).toMatchObject({ status: "empty", metadata: { resultCount: 0, untrustedContent: true } });
  });

  it("安全策略错误仅返回代码、消息和可重试性", async () => {
    const tool = createWebReadTool({ read: async () => { throw new WebResearchSecurityError("WEB_URL_BLOCKED"); } });

    const result = await tool.execute("call", { url: "http://127.0.0.1" }, undefined, undefined, {} as never);

    expect(parseResult(result)).toEqual({
      status: "error",
      error: { code: "WEB_URL_BLOCKED", message: "该网页地址不符合当前安全策略", retryable: false },
    });
  });
});
