import { extractFromHtml } from "@extractus/article-extractor";

import type { WebResearchConfigDocument } from "../../shared/web-research-contracts";
import type { CredentialService } from "../configuration/credential-service";
import { selectWebWindow } from "./web-text-window";
import { WebEvidenceError, WebEvidenceState, waitForEvidence } from "./web-evidence-state";
import { SafeWebClient } from "./safe-web-client";
import { WebResearchConfigService } from "./web-research-config-service";
import { EgressProfileRegistry } from "./egress-profile-registry";
import { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";
import type { SearchProviderHealth, SearchProviderInput, SearchProviderItem, SearchProviderResult } from "./search-provider";
import { SearchProviderFactory } from "./search-provider-factory";
import { SearchProviderRouter } from "./search-provider-router";
import { SearchRunState } from "./search-run-state";
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
export interface WebReadInput {
  url: string;
  action?: "read" | "find";
  query?: string | null;
  startParagraph?: number | null;
  maxCharacters?: number;
}

/** 网页的正文窗口与来源信息。 */
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
    paragraphs: Array<{ paragraph: number; text: string }>;
    totalParagraphs: number;
    matchedParagraphs: number[];
    totalMatches: number;
    nextParagraph: number | null;
  };
  metadata: { truncated: boolean; contentCharacters: number; returnedCharacters: number; untrustedContent: true };
  warnings: ToolWarning[];
}

interface WebResearchServiceDependencies {
  readConfig(): Promise<WebResearchConfigDocument>;
  searchProviders(config: WebResearchConfigDocument["config"], input: SearchProviderInput, state: SearchRunState): Promise<SearchProviderResult>;
  testSearchProvider(config: WebResearchConfigDocument["config"]["searchProviders"][number], input: SearchProviderInput): Promise<SearchProviderResult>;
  fetchText(url: string, config: WebResearchConfigDocument["config"], signal?: AbortSignal): ReturnType<SafeWebClient["fetchText"]>;
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
  async search(input: { query: string; count?: number; site?: string; language?: string; timeRange?: string; signal?: AbortSignal }, state = new SearchRunState()): Promise<WebSearchServiceResult> {
    const { config } = await this.dependencies.readConfig();
    assertEnabled(config.enabled);
    const count = Math.min(Math.max(input.count ?? config.maxResults, 1), config.maxResults);
    const providerResult = await waitForEvidence(this.dependencies.searchProviders(config, { ...input, count }, state), input.signal);
    const rawResults = readSearchResults(providerResult.results);
    // URL 安全过滤后重新归一化健康状态，避免把仅含非法地址的故障响应误报为空结果。
    const providerHealth: SearchProviderHealth = providerResult.health === "degraded" && rawResults.length === 0
      ? "unavailable"
      : providerResult.health;
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
  async read(input: WebReadInput, state = new WebEvidenceState(), signal?: AbortSignal): Promise<WebReadServiceResult> {
    const { config } = await this.dependencies.readConfig();
    assertEnabled(config.enabled);
    signal?.throwIfAborted();
    const document = await state.load("html", input.url, JSON.stringify(config), async () => {
      const page = await waitForEvidence(this.dependencies.fetchText(input.url, config, signal), signal);
      let article = null;
      let extractionFailed = false;
      if (page.contentType === "text/html") {
        try { article = await waitForEvidence(this.dependencies.extract(page.body, page.finalUrl), signal); }
        catch { signal?.throwIfAborted(); extractionFailed = true; }
      }
      const articleText = article?.content?.trim();
      const extractionMode = page.contentType === "text/plain" ? "plain_text" as const : articleText ? "article" as const : "html_fallback" as const;
      const text = extractionMode === "plain_text" ? page.body.trim() : stripHtml(articleText || page.body);
      if (text.length > 500_000) throw new WebEvidenceError("WEB_RESPONSE_TOO_LARGE", "网页提取后的正文超过取证缓存上限");
      const warnings: ToolWarning[] = extractionMode === "html_fallback"
        ? [{ code: extractionFailed ? "ARTICLE_EXTRACTION_FAILED" : "ARTICLE_EXTRACTION_FALLBACK", message: extractionFailed ? "网页正文提取器执行失败，返回清理后的 HTML 文本" : "网页未识别出文章正文，返回清理后的 HTML 文本" }]
        : [];
      const value = { finalUrl: page.finalUrl, title: article?.title?.trim() || page.finalUrl, text, publishedAt: normalizePublishedDate(article?.published), fetchedAt: new Date().toISOString(), contentType: page.contentType, extractionMode, warnings };
      return { value, bytes: Buffer.byteLength(text, "utf8") };
    });
    signal?.throwIfAborted();
    const maxCharacters = Math.min(Math.max(input.maxCharacters ?? 6_000, 1), config.maxTextLength);
    const window = selectWebWindow(document.text, { ...input, maxCharacters });
    return {
      data: { requestedUrl: input.url, finalUrl: document.finalUrl, title: document.title, hostname: new URL(document.finalUrl).hostname.toLowerCase(), publishedAt: document.publishedAt, fetchedAt: document.fetchedAt, contentType: document.contentType, extractionMode: document.extractionMode, ...window },
      metadata: { truncated: window.truncated, contentCharacters: document.text.length, returnedCharacters: window.text.length, untrustedContent: true },
      warnings: document.warnings,
    };
  }

  /** 验证受管 SearXNG 是否可返回 JSON 搜索结果。 */
  async testConnection(): Promise<void> {
    const { config } = await this.dependencies.readConfig();
    const provider = config.searchProviders.find((candidate) => candidate.enabled);
    if (!provider) throw new Error("尚未配置可用的搜索服务");
    const result = await this.dependencies.testSearchProvider(provider, { query: "BugPaw", count: 1 });
    if (result.health === "unavailable") {
      throw new Error("搜索供应商当前不可用");
    }
  }

  /** 只测试指定已保存实例，不触发路由故障切换。 */
  async testProvider(providerId: string): Promise<void> {
    const { config } = await this.dependencies.readConfig();
    const provider = config.searchProviders.find((candidate) => candidate.id === providerId);
    if (!provider) throw new Error("搜索服务不存在");
    const result = await this.dependencies.testSearchProvider(provider, { query: "BugPaw", count: 1 });
    if (result.health === "unavailable") throw new Error("搜索供应商当前不可用");
  }
}

/** 创建生产环境使用的联网搜索服务。 */
export function createWebResearchService(
  configs: WebResearchConfigService,
  egressProfiles = new EgressProfileRegistry(),
  client = new SafeWebClient(),
  managedProviders = new ManagedSearchProviderRegistry(false),
  credentials?: Pick<CredentialService, "getApiKey">,
): WebResearchService {
  const factory = new SearchProviderFactory({
    credentials: credentials ?? { getApiKey: async () => undefined },
    managedProviders,
    egressProfiles,
  });
  const router = new SearchProviderRouter(factory);
  return new WebResearchService({
    readConfig: () => configs.read(),
    searchProviders: (config, input, state) => router.search(config.searchProviders, input, state),
    testSearchProvider: async (provider, input) => (await factory.create(provider)).search(input),
    fetchText: async (url, config, signal) => client.fetchText(url, config, await egressProfiles.require(config.webRead.egressProfileId), signal),
    extract: (html, url) => extractFromHtml(html, url),
  });
}

/** 当管理员未启用全局能力时，不允许工具执行。 */
function assertEnabled(enabled: boolean): asserts enabled {
  if (!enabled) throw new WebEvidenceError("WEB_RESEARCH_DISABLED", "联网检索全局能力未启用");
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
  return value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>|<br\s*\/?>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/[^\S\n]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
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
