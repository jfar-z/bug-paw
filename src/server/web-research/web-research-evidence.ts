import type { WebReadInput, WebReadServiceResult, WebSearchServiceResult } from "./web-research-service";
import { WebResearchSecurityError } from "./safe-web-client";
import { SearchRunState } from "./search-run-state";
import { WebEvidenceError, waitForEvidence } from "./web-evidence-state";

/** 单次取证最多三条独立查询、三个页面，不生成厂商答案。 */
export interface WebResearchInput {
  queries: string[];
  site: string | null;
  language: string | null;
  timeRange: string | null;
  maxPages: number;
}

/** 将边界内的异常转换成可追踪、可重试的脱敏事实。 */
export function evidenceError(error: unknown) {
  const value = error instanceof Error ? error as Error & { code?: string; retryable?: boolean; details?: Record<string, unknown> } : undefined;
  if (value?.name === "AbortError" || value?.name === "TimeoutError") return { code: "WEB_OPERATION_CANCELLED", message: "联网取证已取消或达到总时间预算", retryable: false, details: { phase: "budget" } };
  if (error instanceof WebEvidenceError || error instanceof WebResearchSecurityError) {
    return { code: error.code, message: error.message, retryable: error.retryable, details: error.details };
  }
  // 文件系统及依赖原始错误可能含内部路径，不能直接回显 code/message/details。
  return { code: "WEB_EVIDENCE_SERVICE_FAILED", message: "联网取证服务在配置读取或内部处理阶段执行失败", retryable: false, details: { phase: "service" } };
}

/** 仅让两个 worker 执行任务，不提前创建全部联网请求。 */
async function boundedMap<T, R>(values: T[], operation: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(2, values.length) }, async () => {
    while (index < values.length) {
      const current = index++;
      // 已取消的剩余项仍交给 operation 生成明确的预算错误，不再发起请求。
      results[current] = await operation(values[current]!);
    }
  }));
  return results;
}

/** 搜索与正文读取合并为一次模型往返，逐项保留失败，不隐藏缺失证据。 */
export async function researchWebEvidence(service: {
  search(input: { query: string; count?: number; site?: string; language?: string; timeRange?: string; signal?: AbortSignal }, state: SearchRunState): Promise<WebSearchServiceResult>;
  read(input: WebReadInput, state: SearchRunState["evidence"], signal?: AbortSignal): Promise<WebReadServiceResult>;
}, input: WebResearchInput, state: SearchRunState, externalSignal?: AbortSignal) {
  if (input.queries.length < 1 || input.queries.length > 3 || input.queries.some((query) => !query.trim()) || input.maxPages < 1 || input.maxPages > 3) {
    throw new WebEvidenceError("WEB_INVALID_PARAMETERS", "组合取证需要 1 至 3 条非空查询和 1 至 3 个正文来源");
  }
  const startedAt = Date.now();
  const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const searches = await boundedMap([...new Set(input.queries)], async (query) => {
    try {
      signal.throwIfAborted();
      if (state.circuit().open) throw new WebEvidenceError("SEARCH_PROVIDERS_UNAVAILABLE", "搜索供应商在本次运行中已不可用，未重复请求");
      const result = await waitForEvidence(service.search({ query, count: 5, site: input.site ?? undefined, language: input.language ?? undefined, timeRange: input.timeRange ?? undefined, signal }, state), signal);
      return { query, status: result.metadata.providerHealth === "unavailable" ? "error" as const : "ok" as const, results: result.data.results.map((item) => ({ ...item, snippet: item.snippet.slice(0, 500) })), warnings: result.warnings, ...(result.metadata.providerHealth === "unavailable" ? { error: { code: "SEARCH_PROVIDERS_UNAVAILABLE", message: "搜索供应商当前不可用", retryable: result.metadata.providerRetryable } } : {}) };
    } catch (error) { return { query, status: "error" as const, results: [], warnings: [], error: evidenceError(error) }; }
  });
  // 按各查询排名交错取候选，避免第一条查询占满全部取证额度。
  const candidates = new Map<string, string>();
  for (let rank = 0; rank < 5; rank += 1) for (const search of searches) {
    const item = search.results[rank];
    if (!item) continue;
    const key = new URL(item.url); key.hash = "";
    if (!candidates.has(key.toString())) candidates.set(key.toString(), item.url);
  }
  const evidence = await boundedMap([...candidates.values()].slice(0, input.maxPages), async (url) => {
    try {
      signal.throwIfAborted();
      const result = await waitForEvidence(service.read({ url, action: "read", maxCharacters: 4000 }, state.evidence, signal), signal);
      const { text: _text, ...data } = result.data;
      return { url, status: result.warnings.length || result.metadata.truncated ? "partial" as const : "ok" as const, data, metadata: result.metadata, warnings: result.warnings };
    } catch (error) { return { url, status: "error" as const, error: evidenceError(error) }; }
  });
  return { searches, evidence, elapsedMs: Date.now() - startedAt, budgetMs: 20_000, untrustedContent: true as const };
}
