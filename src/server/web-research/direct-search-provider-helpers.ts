import type { SearchProviderFailure, SearchProviderFailureCategory, SearchProviderItem, SearchProviderResult } from "./search-provider";

/** 将直接 API 异常投影为实例级脱敏失败。 */
export function unavailableResult(providerId: string, error: unknown): SearchProviderResult {
  const category = readCategory(error);
  const retryable = isRecord(error) && typeof error.retryable === "boolean" ? error.retryable : category !== "authentication";
  const retryAfterMs = isRecord(error) && typeof error.retryAfterMs === "number" ? error.retryAfterMs : undefined;
  const failure: SearchProviderFailure = { provider: providerId, category, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  return { health: "unavailable", results: [], failures: [failure] };
}

/** 只接受普通对象中的 HTTP(S) 候选结果。 */
export function mapHttpItem(value: unknown, fields: { title: string; url: string; snippet: string; source: string; publishedAt: string }): SearchProviderItem | null {
  if (!isRecord(value)) return null;
  const rawUrl = value[fields.url];
  if (typeof rawUrl !== "string" || !isHttpUrl(rawUrl)) return null;
  const url = rawUrl;
  return {
    title: typeof value[fields.title] === "string" && value[fields.title] ? value[fields.title] as string : url,
    url,
    snippet: typeof value[fields.snippet] === "string" ? value[fields.snippet] as string : "",
    source: typeof value[fields.source] === "string" && value[fields.source] ? value[fields.source] as string : new URL(url).hostname,
    publishedAt: typeof value[fields.publishedAt] === "string" && value[fields.publishedAt] ? value[fields.publishedAt] as string : null,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCategory(error: unknown): SearchProviderFailureCategory {
  if (!isRecord(error) || typeof error.category !== "string") return "upstream_error";
  return ["rate_limited", "authentication", "timeout", "captcha", "upstream_error"].includes(error.category)
    ? error.category as SearchProviderFailureCategory
    : "upstream_error";
}

function isHttpUrl(value: string): boolean {
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}
