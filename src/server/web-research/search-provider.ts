/** 搜索供应商的统一健康状态。 */
export type SearchProviderHealth = "healthy" | "degraded" | "unavailable";

/** 搜索供应商失败的稳定分类。 */
export type SearchProviderFailureCategory = "rate_limited" | "authentication" | "timeout" | "captcha" | "upstream_error";

/** 不携带供应商原始错误正文的失败事实。 */
export interface SearchProviderFailure {
  provider: string;
  category: SearchProviderFailureCategory;
  retryable: boolean;
  retryAfterMs?: number;
}

/** 供应商返回的未排序搜索结果。 */
export interface SearchProviderItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  publishedAt: string | null;
}

/**
 * 搜索供应商统一结果。
 *
 * 不变量：无失败为 healthy；有失败且有结果为 degraded；有失败且无结果为 unavailable。
 */
export interface SearchProviderResult {
  health: SearchProviderHealth;
  results: SearchProviderItem[];
  failures: SearchProviderFailure[];
}

/** 搜索供应商的通用查询参数。 */
export interface SearchProviderInput {
  query: string;
  count: number;
  site?: string;
  language?: string;
  timeRange?: string;
}

/** 可由 SearXNG 或直接搜索 API 实现的统一接口。 */
export interface SearchProvider {
  search(input: SearchProviderInput): Promise<SearchProviderResult>;
}
