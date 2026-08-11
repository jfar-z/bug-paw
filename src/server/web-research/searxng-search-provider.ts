import type {
  SearchProvider,
  SearchProviderFailure,
  SearchProviderFailureCategory,
  SearchProviderInput,
  SearchProviderItem,
  SearchProviderResult,
} from "./search-provider";

type SearchRequest = (url: URL, timeoutMs: number) => Promise<unknown>;

/** 使用宿主 fetch 请求 SearXNG JSON 接口。 */
async function requestSearxng(url: URL, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

/** 判断未知值是否为可安全读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 将供应商原始失败原因归一为稳定且不泄漏细节的分类。 */
function classifyFailure(reason: string): Pick<SearchProviderFailure, "category" | "retryable"> {
  const normalized = reason.toLowerCase();
  let category: SearchProviderFailureCategory = "upstream_error";
  let retryable = true;

  if (normalized.includes("too many") || normalized.includes("rate limit") || normalized.includes("429")) {
    category = "rate_limited";
  } else if (normalized.includes("captcha")) {
    category = "captcha";
  } else if (normalized.includes("timeout") || normalized.includes("timed out")) {
    category = "timeout";
  } else if (
    normalized.includes("unauthorized")
    || normalized.includes("authentication")
    || normalized.includes("forbidden")
    || normalized.includes("401")
    || normalized.includes("403")
  ) {
    category = "authentication";
    retryable = false;
  }

  return { category, retryable };
}

/** 将 SearXNG 单条结果映射为统一结构。 */
function mapResult(value: unknown): SearchProviderItem | null {
  if (!isRecord(value) || typeof value.url !== "string" || value.url.length === 0) {
    return null;
  }

  return {
    title: typeof value.title === "string" && value.title.length > 0 ? value.title : value.url,
    url: value.url,
    snippet: typeof value.content === "string" ? value.content : "",
    source: typeof value.engine === "string" && value.engine.length > 0 ? value.engine : "searxng",
    publishedAt: typeof value.publishedDate === "string" && value.publishedDate.length > 0 ? value.publishedDate : null,
  };
}

/** 将 SearXNG 引擎失败映射为统一结构。 */
function mapFailure(value: unknown): SearchProviderFailure {
  if (
    !Array.isArray(value)
    || typeof value[0] !== "string"
    || value[0].length === 0
    || typeof value[1] !== "string"
  ) {
    return { provider: "searxng", category: "upstream_error", retryable: true };
  }
  return { provider: value[0], ...classifyFailure(value[1]) };
}

/** 将 SearXNG JSON 映射为统一搜索供应商结果。 */
export function mapSearxngSearchResponse(value: unknown): SearchProviderResult {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error("搜索服务返回格式无效");
  }

  const results = value.results.map(mapResult).filter((item): item is SearchProviderItem => item !== null);
  const failures = Array.isArray(value.unresponsive_engines)
    ? value.unresponsive_engines.map(mapFailure)
    : [];
  const health = failures.length === 0 ? "healthy" : results.length > 0 ? "degraded" : "unavailable";
  return { health, results, failures };
}

/** 通过统一搜索供应商协议访问 SearXNG。 */
export class SearxngSearchProvider implements SearchProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly request: SearchRequest = requestSearxng,
  ) {}

  /** 构造查询并返回归一化搜索结果。 */
  async search(input: SearchProviderInput): Promise<SearchProviderResult> {
    const url = new URL("search", `${this.baseUrl.replace(/\/$/, "")}/`);
    url.searchParams.set("format", "json");
    url.searchParams.set("q", input.site ? `${input.query} site:${input.site}` : input.query);
    url.searchParams.set("language", input.language ?? "auto");
    if (input.timeRange) {
      url.searchParams.set("time_range", input.timeRange);
    }

    try {
      return mapSearxngSearchResponse(await this.request(url, this.timeoutMs));
    } catch (error) {
      const reason = error instanceof Error ? `${error.name} ${error.message}` : "unknown upstream error";
      return {
        health: "unavailable",
        results: [],
        failures: [{ provider: "searxng", ...classifyFailure(reason) }],
      };
    }
  }
}
