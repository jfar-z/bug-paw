import { ProxyAgent, fetch as undiciFetch } from "undici";

import type { WebResearchEgressProfile } from "../../shared/web-research-egress-contracts";
import type { SearchProviderFailureCategory } from "./search-provider";

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface SearchProviderHttpInput {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  egressProfile: WebResearchEgressProfile;
}

interface SearchProviderTransportResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

type SearchProviderTransport = (input: SearchProviderHttpInput) => Promise<SearchProviderTransportResponse>;

/** 只携带稳定分类和等待时间的搜索上游错误。 */
export class SearchProviderHttpError extends Error {
  constructor(
    readonly category: SearchProviderFailureCategory,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super("搜索供应商请求失败");
    this.name = "SearchProviderHttpError";
  }
}

/** 对直接搜索 API 执行限时、限量且脱敏的 JSON 请求。 */
export class SearchProviderHttpClient {
  constructor(private readonly transport: SearchProviderTransport = requestJsonTransport) {}

  async requestJson(input: SearchProviderHttpInput): Promise<unknown> {
    let response: SearchProviderTransportResponse;
    try {
      response = await this.transport(input);
    } catch (error) {
      if (error instanceof SearchProviderHttpError) throw error;
      const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") throw new SearchProviderHttpError("timeout", true);
      throw new SearchProviderHttpError("upstream_error", true);
    }

    if (response.status < 200 || response.status >= 300) {
      if (response.status === 401 || response.status === 403) throw new SearchProviderHttpError("authentication", false);
      if (response.status === 429) throw new SearchProviderHttpError("rate_limited", true, parseRetryAfter(response.headers["retry-after"]));
      throw new SearchProviderHttpError("upstream_error", response.status >= 500);
    }
    try {
      return JSON.parse(response.body) as unknown;
    } catch {
      throw new SearchProviderHttpError("upstream_error", true);
    }
  }
}

/** 使用受管出口发送请求，响应体超过上限时立即终止。 */
async function requestJsonTransport(input: SearchProviderHttpInput): Promise<SearchProviderTransportResponse> {
  const proxyAgent = input.egressProfile.kind === "http-proxy" ? new ProxyAgent(input.egressProfile.proxyUrl) : undefined;
  try {
    const response = await undiciFetch(input.url, {
      method: input.method,
      headers: { accept: "application/json", ...(input.body === undefined ? {} : { "content-type": "application/json" }), ...input.headers },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      ...(proxyAgent ? { dispatcher: proxyAgent } : {}),
      signal: AbortSignal.timeout(input.timeoutMs),
      redirect: "error",
    });
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) throw new SearchProviderHttpError("upstream_error", true);
    const body = await readLimitedBody(response.body as unknown as AsyncIterable<Uint8Array> | null);
    return {
      status: response.status,
      headers: { ...(response.headers.get("retry-after") ? { "retry-after": response.headers.get("retry-after")! } : {}) },
      body,
    };
  } finally {
    await proxyAgent?.close();
  }
}

async function readLimitedBody(body: AsyncIterable<Uint8Array> | null): Promise<string> {
  if (!body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_RESPONSE_BYTES) throw new SearchProviderHttpError("upstream_error", true);
    chunks.push(chunk);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  if (/^\d+$/u.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
