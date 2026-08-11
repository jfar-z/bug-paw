import type { WebResearchEgressProfile } from "../../shared/web-research-egress-contracts";
import { isRecord, mapHttpItem, unavailableResult } from "./direct-search-provider-helpers";
import type { SearchProvider, SearchProviderInput, SearchProviderResult } from "./search-provider";
import type { SearchProviderHttpClient } from "./search-provider-http-client";

/** 只使用博查 Web Search 候选网页接口。 */
export class BochaSearchProvider implements SearchProvider {
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
        url: "https://api.bochaai.com/v1/web-search",
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}` },
        body: {
          query: input.site ? `${input.query} site:${input.site}` : input.query,
          count: input.count,
          freshness: mapFreshness(input.timeRange),
          summary: true,
        },
        timeoutMs: this.timeoutMs,
        egressProfile: this.egressProfile,
      });
      const data = isRecord(value) && isRecord(value.data) ? value.data : undefined;
      const webPages = data && isRecord(data.webPages) ? data.webPages : undefined;
      if (!webPages || !Array.isArray(webPages.value)) throw new Error("搜索服务返回格式无效");
      const results = webPages.value.map((item) => mapHttpItem(item, {
        title: "name", url: "url", snippet: "snippet", source: "siteName", publishedAt: "datePublished",
      })).filter((item): item is NonNullable<typeof item> => item !== null);
      return { health: "healthy", results, failures: [] };
    } catch (error) {
      return unavailableResult(this.providerId, error);
    }
  }
}

function mapFreshness(value: string | undefined): string {
  return ({ day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" } as Record<string, string>)[value ?? ""] ?? "noLimit";
}
