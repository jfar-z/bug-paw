// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { DEFAULT_AGENT_TOOL_NAMES } from "../../shared/tool-catalog";
import { resolveEffectiveRetrievalCapabilities } from "../agent-retrieval-capabilities";
import { SafeWebClient, WebResearchSecurityError } from "./safe-web-client";
import { WebEvidenceState } from "./web-evidence-state";
import { WebResearchService } from "./web-research-service";
import { SearchRunState } from "./search-run-state";
import { evidenceError, researchWebEvidence } from "./web-research-evidence";
import { createPdfReadTool, createWebReadTool, createWebResearchTool } from "./web-research-tools";
import { PdfEvidenceService } from "./pdf-evidence-service";
import { parsePdfEvidence } from "./pdf-reader";
import { selectWebWindow } from "./web-text-window";

const config = { ...DEFAULT_WEB_RESEARCH_CONFIG, enabled: true };
const url = "https://example.org/article";

/** 创建公开、无凭证的内存服务，验证业务行为而非真实外网可用性。 */
function htmlService(body = "first\n\nneedle fact\n\nlast") {
  const fetchText = vi.fn(async () => ({ finalUrl: url, contentType: "text/plain" as const, body }));
  const readConfig = vi.fn(async () => ({ revision: "one", config }));
  const service = new WebResearchService({ readConfig, fetchText, extract: vi.fn(async () => null), searchProviders: vi.fn(), testSearchProvider: vi.fn() });
  return { service, fetchText, readConfig };
}

/** 手工组装两页合法 PDF：第一页有文字，第二页仅有图形，无需额外生成依赖。 */
function pdfFixture(): Buffer {
  const stream = (value: string) => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    stream("BT /F1 12 Tf 20 350 Td (needle public evidence) Tj ET"),
    stream("0 0 1 rg 20 20 120 120 re f"),
    "<< /Title (Public test document) >>",
  ];
  let content = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}

describe("公开资源读取分类与安全边界", () => {
  it("区分 DNS、连接和 HTTP 拒绝的阶段与重试条件", async () => {
    const dns = new SafeWebClient({ resolve: vi.fn(async () => { throw new Error("private detail"); }), request: vi.fn() });
    await expect(dns.fetchText(url, config)).rejects.toMatchObject({ code: "WEB_DNS_FAILED", retryable: true, details: { phase: "dns" } });
    const connection = new SafeWebClient({ resolve: async () => ["93.184.216.34"], request: async () => { throw new Error("private detail"); } });
    await expect(connection.fetchText(url, config)).rejects.toMatchObject({ code: "WEB_CONNECTION_FAILED", retryable: true });
    for (const status of [403, 404, 429, 503]) {
      const client = new SafeWebClient({ resolve: async () => ["93.184.216.34"], request: async () => ({ statusCode: status, headers: {}, body: "credential must not appear" }) });
      await expect(client.fetchText(url, config)).rejects.toMatchObject({ code: "WEB_HTTP_ERROR", retryable: status >= 429, details: { httpStatus: status } });
      await expect(client.fetchText(url, config)).rejects.not.toThrow("credential");
    }
  });

  it("PDF 明确识别且保持二进制，拒绝伪装、私网、重定向私网与过大响应", async () => {
    const request = vi.fn(async () => ({ statusCode: 200, headers: { "content-type": "application/pdf" }, body: pdfFixture() }));
    const client = new SafeWebClient({ resolve: async () => ["93.184.216.34"], request });
    await expect(client.fetchText(url, config)).rejects.toMatchObject({ code: "WEB_PDF_DETECTED", retryable: false });
    expect((await client.fetchPdf(url, config)).body.equals(pdfFixture())).toBe(true);
    request.mockResolvedValueOnce({ statusCode: 200, headers: { "content-type": "application/pdf" }, body: Buffer.from("invalid") });
    await expect(client.fetchPdf(url, config)).rejects.toMatchObject({ code: "WEB_CONTENT_TYPE_BLOCKED" });
    await expect(client.fetchPdf(url, { ...config, maxResponseBytes: 10 })).rejects.toMatchObject({ code: "WEB_RESPONSE_TOO_LARGE" });
    await expect(client.fetchPdf("https://127.0.0.1/a.pdf", config)).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
    request.mockResolvedValueOnce({ statusCode: 302, headers: { location: "https://127.0.0.1/private" } as never, body: Buffer.from("") });
    await expect(client.fetchPdf(url, config)).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
  });

  it("DNS 和完整重定向请求共用总截止时间", async () => {
    const client = new SafeWebClient({ resolve: () => new Promise(() => undefined), request: vi.fn() });
    await expect(client.fetchText(url, { ...config, webRead: { ...config.webRead, timeoutMs: 20 } })).rejects.toMatchObject({ code: "WEB_FETCH_TIMEOUT" });
  });
});

describe("Run 级缓存、重试控制与正文定位", () => {
  it("同址并发合并、失败斜杠变体阻止，下轮恢复且保留失败状态", async () => {
    const state = new WebEvidenceState();
    const fail = vi.fn(async () => { throw new WebResearchSecurityError("WEB_HTTP_ERROR", { phase: "http", httpStatus: 403 }, false); });
    const attempts = await Promise.allSettled([state.load("html", url, "p", fail), state.load("html", url, "p", fail)]);
    expect(attempts.every((result) => result.status === "rejected")).toBe(true);
    expect(fail).toHaveBeenCalledTimes(1);
    await expect(state.load("html", `${url}/`, "p", fail)).rejects.toMatchObject({ code: "WEB_READ_RETRY_BLOCKED", details: { originalCode: "WEB_HTTP_ERROR", httpStatus: 403 } });
    expect(fail).toHaveBeenCalledTimes(1);
    state.reset();
    await expect(state.load("html", url, "p", fail)).rejects.toMatchObject({ code: "WEB_HTTP_ERROR" });
    expect(fail).toHaveBeenCalledTimes(2);
  });

  it("查找命中段落与上下文，缓存命中仍检查新策略", async () => {
    const { service, fetchText, readConfig } = htmlService();
    const state = new WebEvidenceState();
    const result = await service.read({ url, action: "find", query: "needle", startParagraph: null }, state);
    expect(result.data.matchedParagraphs).toEqual([2]);
    expect(result.data.paragraphs.map((item) => item.paragraph)).toEqual([1, 2, 3]);
    await service.read({ url, action: "read", startParagraph: 2 }, state);
    expect(fetchText).toHaveBeenCalledTimes(1);
    readConfig.mockResolvedValueOnce({ revision: "two", config: { ...config, enabled: false } });
    await expect(service.read({ url }, state)).rejects.toThrow("未启用");
    readConfig.mockResolvedValueOnce({ revision: "three", config: { ...config, allowedDomains: ["different.org"] } });
    await service.read({ url }, state);
    expect(fetchText).toHaveBeenCalledTimes(2);
  });

  it("长段落可以继续读取，不会总是重复同一窗口", () => {
    const text = "x".repeat(3500);
    const first = selectWebWindow(text, { maxCharacters: 1000 });
    expect(first.text.length).toBeLessThanOrEqual(1000);
    expect(first.nextParagraph).toBe(2);
    const second = selectWebWindow(text, { startParagraph: first.nextParagraph, maxCharacters: 1000 });
    expect(second.paragraphs[0]?.paragraph).toBe(2);
    expect(second.nextParagraph).toBe(3);
    const found = selectWebWindow(`${"x".repeat(1000)}\n\nneedle`, { action: "find", query: "needle", maxCharacters: 1000 });
    expect(found.matchedParagraphs).toEqual([2]); expect(found.text).toContain("needle");
  });

  it("旧 Run 的在途结果不会写入新 Run 缓存", async () => {
    const state = new WebEvidenceState();
    let complete!: (value: { value: number; bytes: number }) => void;
    const old = state.load<number>("html", url, "p", () => new Promise((resolve) => { complete = resolve; }));
    state.reset(); complete({ value: 1, bytes: 1 }); await old;
    const fresh = vi.fn(async () => ({ value: 2, bytes: 1 }));
    expect(await state.load("html", url, "p", fresh)).toBe(2);
    expect(fresh).toHaveBeenCalledOnce();
  });
});

describe("组合取证、PDF 与权限", () => {
  it("交错选择独立查询来源、去重并限制双路并发，失败逐项保留", async () => {
    const { service } = htmlService();
    let active = 0; let maximum = 0;
    const search = vi.fn(async ({ query }: { query: string }) => ({ data: { query, results: [url, `${url}/${query}`].map((href, index) => ({ rank: index + 1, title: query, url: href, hostname: "example.org", snippet: "s".repeat(1000), sourceEngines: [], publishedAt: null })) }, metadata: { resultCount: 2, duplicatesRemoved: 0, truncated: false, providerHealth: "healthy" as const, failedProviderCount: 0, providerRetryable: false }, warnings: [] }));
    const read = vi.fn(async (input: { url: string }) => {
      active += 1; maximum = Math.max(active, maximum);
      await new Promise((resolve) => setTimeout(resolve, 10)); active -= 1;
      if (input.url.endsWith("/b")) throw new WebResearchSecurityError("WEB_HTTP_ERROR", { phase: "http", httpStatus: 403 });
      return service.read(input);
    });
    const result = await researchWebEvidence({ search, read }, { queries: ["a", "b", "c"], site: null, language: null, timeRange: null, maxPages: 3 }, new SearchRunState());
    expect(read.mock.calls.map(([input]) => input.url)).toEqual([url, `${url}/a`, `${url}/b`]);
    expect(maximum).toBe(2);
    expect(result.evidence[2]).toMatchObject({ status: "error", error: { code: "WEB_HTTP_ERROR" } });
    expect(result.searches[0]?.results[0]?.snippet).toHaveLength(500);
  });

  it("取消在途取证后不继续读取来源，也不永久毒化搜索供应商状态", async () => {
    const controller = new AbortController();
    const search = vi.fn(() => new Promise<never>(() => undefined));
    const read = vi.fn();
    const result = researchWebEvidence({ search, read }, { queries: ["a"], site: null, language: null, timeRange: null, maxPages: 1 }, new SearchRunState(), controller.signal);
    setTimeout(() => controller.abort(), 10);
    expect((await result).searches[0]).toMatchObject({ status: "error", error: { code: "WEB_OPERATION_CANCELLED" } });
    expect(read).not.toHaveBeenCalled();
  });

  it("独立授权不扩权，组合取证不能绕过网页读取权限", () => {
    const legacy = resolveEffectiveRetrievalCapabilities({ allowedTools: ["web_search", "web_read"], webResearchEnabled: true });
    expect(legacy.webResearch).toBe(false); expect(legacy.pdfRead).toBe(false);
    expect(resolveEffectiveRetrievalCapabilities({ allowedTools: ["web_search", "web_research"], webResearchEnabled: true }).webResearch).toBe(false);
    expect(resolveEffectiveRetrievalCapabilities({ allowedTools: ["pdf_read"], webResearchEnabled: false }).pdfRead).toBe(false);
    expect(DEFAULT_AGENT_TOOL_NAMES).toContain("pdf_read");
    expect(JSON.stringify(evidenceError(Object.assign(new Error("/private/auth.json"), { code: "ENOENT" })))).not.toContain("/private");
  });

  it("工具根 Schema 为对象，条件参数错误进入 Pi 错误事件，find 无命中为 empty", async () => {
    const { service } = htmlService();
    const pdf = new PdfEvidenceService({ readConfig: async () => ({ revision: "one", config }), fetchPdf: vi.fn() });
    for (const tool of [createWebReadTool(service), createPdfReadTool(pdf), createWebResearchTool(service, new SearchRunState())]) {
      expect(tool.parameters.type).toBe("object"); expect(tool.parameters).not.toHaveProperty("anyOf");
    }
    const failedService = htmlService();
    failedService.fetchText.mockRejectedValueOnce(new WebResearchSecurityError("WEB_HTTP_ERROR", { phase: "http", httpStatus: 403 }));
    const composite = createWebResearchTool({ read: failedService.service.read.bind(failedService.service), search: async () => ({ data: { query: "a", results: [{ rank: 1, title: "a", url, hostname: "example.org", snippet: "hint", sourceEngines: [], publishedAt: null }] }, metadata: { resultCount: 1, duplicatesRemoved: 0, truncated: false, providerHealth: "healthy", failedProviderCount: 0, providerRetryable: false }, warnings: [] }) }, new SearchRunState());
    await expect(composite.execute("failed", { queries: ["a"], site: null, language: null, timeRange: null, maxPages: 1 }, undefined, undefined, {} as never)).rejects.toThrow('"status":"partial"');
    const tool = createWebReadTool(service);
    await expect(tool.execute("bad", { action: "read", url, query: "invalid", startParagraph: null }, undefined, undefined, {} as never)).rejects.toThrow("WEB_INVALID_PARAMETERS");
    const result = await tool.execute("find", { action: "find", url, query: "absent", startParagraph: null }, undefined, undefined, {} as never);
    expect(JSON.parse(result.content[0]!.type === "text" ? result.content[0]!.text : "{}").status).toBe("empty");
  });

  it("真实隔离进程提取文本、查找页码、识别无文本页面并渲染 PNG", async () => {
    const base = { url, startPage: null, endPage: null, query: null };
    const inspect = await parsePdfEvidence(pdfFixture(), { ...base, action: "inspect" });
    expect(inspect.totalPages).toBe(2); expect(inspect.title).toBe("Public test document"); expect(inspect.pages[0]?.text).toContain("needle");
    const find = await parsePdfEvidence(pdfFixture(), { ...base, action: "find", startPage: 1, endPage: 2, query: "needle" });
    expect(find.pages.map((page) => page.page)).toEqual([1]);
    const page = await parsePdfEvidence(pdfFixture(), { ...base, action: "read", startPage: 2, endPage: 2 });
    expect(page.pages[0]?.hasText).toBe(false);
    const rendered = await parsePdfEvidence(pdfFixture(), { ...base, action: "render", startPage: 2, endPage: 2 });
    expect(Buffer.from(rendered.image!.data, "base64").subarray(1, 4).toString()).toBe("PNG");
    expect(rendered.image!.width * rendered.image!.height).toBeLessThanOrEqual(2_000_000);
    await expect(parsePdfEvidence(Buffer.from("%PDF-broken"), { ...base, action: "inspect" })).rejects.toMatchObject({ code: "PDF_PARSE_FAILED" });
    await expect(parsePdfEvidence(pdfFixture(), { ...base, action: "read", startPage: 3, endPage: 3 })).rejects.toMatchObject({ code: "PDF_PAGE_OUT_OF_RANGE" });
  }, 30_000);

  it("PDF 连续操作只下载一次，返回图片内容，错误参数不下载", async () => {
    const fetchPdf = vi.fn(async () => ({ finalUrl: "https://example.org/public.pdf", body: pdfFixture() }));
    const service = new PdfEvidenceService({ readConfig: async () => ({ revision: "one", config }), fetchPdf });
    const tool = createPdfReadTool(service);
    const base = { url, query: null };
    await expect(tool.execute("bad", { ...base, action: "inspect", startPage: 1, endPage: null }, undefined, undefined, {} as never)).rejects.toThrow("PDF_INVALID_PARAMETERS");
    expect(fetchPdf).not.toHaveBeenCalled();
    await tool.execute("inspect", { ...base, action: "inspect", startPage: null, endPage: null }, undefined, undefined, {} as never);
    const result = await tool.execute("render", { ...base, action: "render", startPage: 2, endPage: 2 }, undefined, undefined, {} as never);
    expect(fetchPdf).toHaveBeenCalledOnce();
    expect(result.content.some((item) => item.type === "image")).toBe(true);
  }, 15_000);
});
