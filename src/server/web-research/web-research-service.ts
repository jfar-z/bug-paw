import { extractFromHtml } from "@extractus/article-extractor";

import type { WebResearchConfigDocument } from "../../shared/web-research-contracts";
import { SafeWebClient } from "./safe-web-client";
import { WebResearchConfigService } from "./web-research-config-service";
import { EgressProfileRegistry } from "./egress-profile-registry";
import type { ToolWarning } from "../retrieval/tool-response";

/** 规范化后的联网搜索服务结果。 */
export interface WebSearchServiceResult {
  data: {
    query: string;
    results: Array<{
      rank: number;
      title: string;
      url: string;
      hostname: string;
      snippet: string;
      sourceEngines: string[];
      publishedAt: string | null;
    }>;
  };
  metadata: { resultCount: number; duplicatesRemoved: number; truncated: boolean };
  warnings: ToolWarning[];
}

/** 网页正文读取服务结果。 */
export interface WebReadServiceResult {
  data: {
    requestedUrl: string;
    finalUrl: string;
    title: string;
    hostname: string;
    text: string;
    publishedAt: string | null;
    fetchedAt: string;
    contentType: "text/html" | "text/plain";
    extractionMode: "article" | "plain_text" | "html_fallback";
  };
  metadata: { truncated: boolean; contentCharacters: number; returnedCharacters: number; untrustedContent: true };
  warnings: ToolWarning[];
}

interface WebResearchServiceDependencies {
  readConfig(): Promise<WebResearchConfigDocument>;
  searchSearxng(baseUrl: string, input: { query: string; count: number; site?: string; language?: string; timeRange?: string }, timeoutMs: number): Promise<unknown>;
  fetchText(url: string, config: WebResearchConfigDocument["config"]): ReturnType<SafeWebClient["fetchText"]>;
  extract(html: string, url: string): Promise<{ title?: string | null; content?: string | null; published?: string | null } | null>;
}

/**
 * 把受管搜索服务和受限网页读取能力组合为稳定的 Agent 查询接口。
 */
export class WebResearchService {
  private readonly dependencies: WebResearchServiceDependencies;

  /**
   * @param dependencies 可替换依赖，支持隔离网络的单元测试
   */
  constructor(dependencies: WebResearchServiceDependencies) {
    this.dependencies = dependencies;
  }

  /** 搜索互联网并返回带来源的规范化结果。 */
  async search(input: { query: string; count?: number; site?: string; language?: string; timeRange?: string }): Promise<WebSearchServiceResult> {
    const { config } = await this.dependencies.readConfig();
    assertEnabled(config.enabled);
    const count = Math.min(Math.max(input.count ?? config.maxResults, 1), config.maxResults);
    const raw = await this.dependencies.searchSearxng(config.searxngBaseUrl, { ...input, count }, config.timeoutMs);
    const rawResults = readSearchResults(raw);
    const deduplicated = new Map<string, Omit<WebSearchServiceResult["data"]["results"][number], "rank">>();
    for (const result of rawResults) {
      const existing = deduplicated.get(result.url);
      if (existing) {
        for (const engine of result.sourceEngines) {
          if (!existing.sourceEngines.includes(engine)) existing.sourceEngines.push(engine);
        }
        if (existing.publishedAt === null && result.publishedAt !== null) existing.publishedAt = result.publishedAt;
        continue;
      }
      deduplicated.set(result.url, result);
    }
    const unique = [...deduplicated.values()];
    const results = unique.slice(0, count).map((result, index) => ({ rank: index + 1, ...result }));
    return {
      data: { query: input.query, results },
      metadata: {
        resultCount: results.length,
        duplicatesRemoved: rawResults.length - unique.length,
        truncated: unique.length > results.length,
      },
      warnings: [],
    };
  }

  /** 读取公开网页并返回经过长度限制的正文。 */
  async read(input: { url: string; maxCharacters?: number }): Promise<WebReadServiceResult> {
    const { config } = await this.dependencies.readConfig();
    assertEnabled(config.enabled);
    const page = await this.dependencies.fetchText(input.url, config);
    const article = page.contentType === "text/html"
      ? await this.dependencies.extract(page.body, page.finalUrl).catch(() => null)
      : null;
    const articleText = article?.content?.trim();
    const extractionMode = page.contentType === "text/plain"
      ? "plain_text"
      : articleText
        ? "article"
        : "html_fallback";
    const fullText = extractionMode === "plain_text"
      ? page.body.trim()
      : extractionMode === "article"
        ? articleText!
        : stripHtml(page.body);
    const maxCharacters = Math.min(Math.max(input.maxCharacters ?? config.maxTextLength, 1), config.maxTextLength);
    const text = fullText.slice(0, maxCharacters);
    const warnings: ToolWarning[] = extractionMode === "html_fallback"
      ? [{ code: "ARTICLE_EXTRACTION_FALLBACK", message: "文章正文提取失败，已降级为 HTML 文本" }]
      : [];
    return {
      data: {
        requestedUrl: input.url,
        finalUrl: page.finalUrl,
        title: article?.title?.trim() || page.finalUrl,
        hostname: new URL(page.finalUrl).hostname.toLowerCase(),
        text,
        publishedAt: normalizePublishedDate(article?.published),
        fetchedAt: new Date().toISOString(),
        contentType: page.contentType,
        extractionMode,
      },
      metadata: {
        truncated: text.length < fullText.length,
        contentCharacters: fullText.length,
        returnedCharacters: text.length,
        untrustedContent: true,
      },
      warnings,
    };
  }

  /** 验证受管 SearXNG 是否可返回 JSON 搜索结果。 */
  async testConnection(): Promise<void> {
    const { config } = await this.dependencies.readConfig();
    await this.dependencies.searchSearxng(config.searxngBaseUrl, { query: "BugPaw", count: 1 }, config.timeoutMs);
  }
}

/** 创建生产环境使用的联网搜索服务。 */
export function createWebResearchService(configs: WebResearchConfigService, egressProfiles = new EgressProfileRegistry(), client = new SafeWebClient()): WebResearchService {
  return new WebResearchService({
    readConfig: () => configs.read(),
    fetchText: async (url, config) => client.fetchText(url, config, await egressProfiles.require(config.egressProfileId)),
    extract: (html, url) => extractFromHtml(html, url),
    async searchSearxng(baseUrl, input, timeoutMs) {
      const url = new URL("search", `${baseUrl}/`);
      url.searchParams.set("format", "json");
      url.searchParams.set("q", input.site ? `${input.query} site:${input.site}` : input.query);
      url.searchParams.set("language", input.language ?? "auto");
      if (input.timeRange) url.searchParams.set("time_range", input.timeRange);
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) throw new Error("搜索服务暂不可用");
      return response.json();
    },
  });
}

/** 当管理员未启用全局能力时，不允许工具执行。 */
function assertEnabled(enabled: boolean): asserts enabled {
  if (!enabled) throw new Error("联网搜索尚未启用，请先在能力扩展中启用");
}

/** 对 SearXNG 非法或不完整响应进行保守过滤。 */
function readSearchResults(value: unknown): Array<Omit<WebSearchServiceResult["data"]["results"][number], "rank">> {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== "string") return [];
    const url = canonicalizeHttpUrl(item.url);
    if (!url) return [];
    const hostname = new URL(url).hostname.toLowerCase();
    const engine = typeof item.engine === "string" && item.engine.trim() ? item.engine.trim() : hostname;
    return [{
      title: typeof item.title === "string" && item.title.trim() ? item.title.trim() : url,
      url,
      hostname,
      snippet: typeof item.content === "string" ? item.content.trim() : "",
      sourceEngines: [engine],
      publishedAt: normalizePublishedDate(item.publishedDate),
    }];
  });
}

/** 将无正文提取结果的静态 HTML 降级为可读纯文本。 */
function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim();
}

/** 判断搜索结果 URL 是否为可引用的 HTTP 地址。 */
function canonicalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hostname = url.hostname.toLowerCase();
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** 只保留可验证的发布时间，不根据模糊文本猜测。 */
function normalizePublishedDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim();
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) return normalized;
  return new Date(timestamp).toISOString();
}

/** 判断未知值是否为对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
