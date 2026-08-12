import type { WebResearchEgressProfile } from "../../shared/web-research-egress-contracts";
import { isRecord, mapHttpItem, unavailableResult } from "./direct-search-provider-helpers";
import type { SearchProvider, SearchProviderInput, SearchProviderResult } from "./search-provider";
import type { SearchProviderHttpClient } from "./search-provider-http-client";

/** 使用固定基础参数调用 Tavily Search，拒绝厂商生成答案。 */
export class TavilySearchProvider implements SearchProvider {
  constructor(
    private readonly providerId: string,
    private readonly apiKey: string | undefined,
    private readonly timeoutMs: number,
    private readonly egressProfile: WebResearchEgressProfile,
    private readonly client: Pick<SearchProviderHttpClient, "requestJson">,
  ) {}

  async search(input: SearchProviderInput): Promise<SearchProviderResult> {
    if (!this.apiKey) return unavailableResult(this.providerId, { category: "authentication", retryable: false });
    try {
      const value = await this.client.requestJson({
        url: "https://api.tavily.com/search",
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: {
          query: input.query,
          max_results: input.count,
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
          auto_parameters: false,
          ...(input.site ? { include_domains: [input.site] } : {}),
          ...(input.timeRange ? { time_range: input.timeRange } : {}),
        },
        timeoutMs: this.timeoutMs,
        egressProfile: this.egressProfile,
      });
      if (!isRecord(value) || !Array.isArray(value.results)) throw new Error("搜索服务返回格式无效");
      const results = value.results.map((item) => mapHttpItem(item, {
        title: "title", url: "url", snippet: "content", source: "source", publishedAt: "published_date",
      })).filter((item): item is NonNullable<typeof item> => item !== null).map((item) => ({
        ...item,
        source: item.source || new URL(item.url).hostname,
      }));
      return { health: "healthy", results, failures: [] };
    } catch (error) {
      return unavailableResult(this.providerId, error);
    }
  }
}
