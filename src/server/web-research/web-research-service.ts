import { extractFromHtml } from "@extractus/article-extractor";

import type { WebResearchConfigDocument } from "../../shared/web-research-contracts";
import { SafeWebClient } from "./safe-web-client";
import { WebResearchConfigService } from "./web-research-config-service";
import { EgressProfileRegistry } from "./egress-profile-registry";

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
  async search(input: { query: string; count?: number; site?: string; language?: string; timeRange?: string }): Promise<{ results: Array<{ title: string; url: string; snippet: string; source: string }> }> {
    const { config } = await this.dependencies.readConfig();
    assertEnabled(config.enabled);
    const count = Math.min(Math.max(input.count ?? config.maxResults, 1), config.maxResults);
    const raw = await this.dependencies.searchSearxng(config.searxngBaseUrl, { ...input, count }, config.timeoutMs);
    return { results: readSearchResults(raw).slice(0, count) };
  }

  /** 读取公开网页并返回经过长度限制的正文。 */
  async open(input: { url: string; maxTextLength?: number }): Promise<{ title: string; finalUrl: string; text: string; published?: string; sourceUrl: string }> {
    const { config } = await this.dependencies.readConfig();
    assertEnabled(config.enabled);
    const page = await this.dependencies.fetchText(input.url, config);
    const article = await this.dependencies.extract(page.body, page.finalUrl);
    const text = (article?.content?.trim() || stripHtml(page.body)).slice(0, Math.min(input.maxTextLength ?? config.maxTextLength, config.maxTextLength));
    return {
      title: article?.title?.trim() || page.finalUrl,
      finalUrl: page.finalUrl,
      text,
      ...(article?.published ? { published: article.published } : {}),
      sourceUrl: page.finalUrl,
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
function readSearchResults(value: unknown): Array<{ title: string; url: string; snippet: string; source: string }> {
  if (!isRecord(value) || !Array.isArray(value.results)) return [];
  return value.results.flatMap((item) => {
    if (!isRecord(item) || typeof item.url !== "string" || !isHttpUrl(item.url)) return [];
    const source = typeof item.engine === "string" ? item.engine : new URL(item.url).hostname;
    return [{ title: typeof item.title === "string" ? item.title : item.url, url: item.url, snippet: typeof item.content === "string" ? item.content : "", source }];
  });
}

/** 将无正文提取结果的静态 HTML 降级为可读纯文本。 */
function stripHtml(value: string): string {
  return value.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").trim();
}

/** 判断搜索结果 URL 是否为可引用的 HTTP 地址。 */
function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** 判断未知值是否为对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
