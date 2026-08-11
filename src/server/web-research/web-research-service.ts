import { extractFromHtml } from "@extractus/article-extractor";

import type { WebResearchConfigDocument } from "../../shared/web-research-contracts";
import { SafeWebClient } from "./safe-web-client";
import { WebResearchConfigService } from "./web-research-config-service";
import { EgressProfileRegistry } from "./egress-profile-registry";
import type { SearchProvider, SearchProviderHealth, SearchProviderItem } from "./search-provider";
import { SearxngSearchProvider } from "./searxng-search-provider";
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
  metadata: {
    resultCount: number;
    duplicatesRemoved: number;
    truncated: boolean;
    providerHealth: SearchProviderHealth;
    failedProviderCount: number;
    providerRetryable: boolean;
  };
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
  createSearchProvider(config: WebResearchConfigDocument["config"]): SearchProvider;
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
    const providerResult = await this.dependencies.createSearchProvider(config).search({ ...input, count });
    const rawResults = readSearchResults(providerResult.results);
    // URL 安全过滤后重新归一化健康状态，避免把仅含非法地址的故障响应误报为空结果。
    const providerHealth: SearchProviderHealth = providerResult.failures.length === 0
      ? providerResult.health
      : rawResults.length > 0 ? "degraded" : "unavailable";
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
        providerHealth,
        failedProviderCount: providerResult.failures.length,
        providerRetryable: providerResult.failures.some((failure) => failure.retryable),
      },
      warnings: providerHealth === "degraded"
        ? [{ code: "SEARCH_PROVIDERS_DEGRADED", message: "部分搜索供应商暂不可用，结果可能不完整" }]
        : [],
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
    const result = await this.dependencies.createSearchProvider(config).search({ query: "BugPaw", count: 1 });
    if (result.health === "unavailable") {
      throw new Error("搜索供应商当前不可用");
    }
  }
}

/** 创建生产环境使用的联网搜索服务。 */
export function createWebResearchService(configs: WebResearchConfigService, egressProfiles = new EgressProfileRegistry(), client = new SafeWebClient()): WebResearchService {
  return new WebResearchService({
    readConfig: () => configs.read(),
    createSearchProvider: (config) => new SearxngSearchProvider(config.searxngBaseUrl, config.timeoutMs),
    fetchText: async (url, config) => client.fetchText(url, config, await egressProfiles.require(config.egressProfileId)),
    extract: (html, url) => extractFromHtml(html, url),
  });
}

/** 当管理员未启用全局能力时，不允许工具执行。 */
function assertEnabled(enabled: boolean): asserts enabled {
  if (!enabled) throw new Error("联网搜索尚未启用，请先在能力扩展中启用");
}

/** 对供应商结果中的非法或不完整地址进行保守过滤。 */
function readSearchResults(value: SearchProviderItem[]): Array<Omit<WebSearchServiceResult["data"]["results"][number], "rank">> {
  return value.flatMap((item) => {
    const url = canonicalizeHttpUrl(item.url);
    if (!url) return [];
    const hostname = new URL(url).hostname.toLowerCase();
    const engine = item.source.trim() || hostname;
    return [{
      title: item.title.trim() || url,
      url,
      hostname,
      snippet: item.snippet.trim(),
      sourceEngines: [engine],
      publishedAt: normalizePublishedDate(item.publishedAt),
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
