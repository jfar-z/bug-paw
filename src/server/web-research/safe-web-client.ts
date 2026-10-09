import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { ProxyAgent, fetch as undiciFetch } from "undici";

import type { WebResearchConfig } from "../../shared/web-research-contracts";
import type { WebResearchEgressProfile } from "../../shared/web-research-egress-contracts";

export type SecurityErrorCode = "WEB_URL_BLOCKED" | "WEB_FETCH_TIMEOUT" | "WEB_RESPONSE_TOO_LARGE" | "WEB_CONTENT_TYPE_BLOCKED" | "WEB_FETCH_FAILED" | "WEB_DNS_FAILED" | "WEB_CONNECTION_FAILED" | "WEB_HTTP_ERROR" | "WEB_PDF_DETECTED";

interface WebResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string | Buffer;
}

interface SafeWebClientDependencies {
  resolve(hostname: string): Promise<string[]>;
  request(url: URL, address: string, timeoutMs: number, maxResponseBytes: number, signal?: AbortSignal): Promise<WebResponse>;
}

/**
 * 以稳定、可纠正的文案返回联网安全错误。
 */
export class WebResearchSecurityError extends Error {
  /** 供工具与接口识别的安全错误代码。 */
  readonly code: SecurityErrorCode;
  /** 仅暴露脱敏后的阶段、状态及重试条件。 */
  readonly details: { phase: string; httpStatus?: number; contentType?: string };
  readonly retryable: boolean;

  /**
   * @param code 安全错误代码
   * @param details 经过白名单脱敏的阶段、HTTP 状态及资源类型
   * @param retryable 是否具备重试条件；Run 仍会阻止重复失败地址
   */
  constructor(code: SecurityErrorCode, details: { phase: string; httpStatus?: number; contentType?: string } = { phase: "fetch" }, retryable = code === "WEB_FETCH_TIMEOUT" || code === "WEB_CONNECTION_FAILED" || code === "WEB_DNS_FAILED") {
    super(`${errorMessage(code)}${details.httpStatus ? `（HTTP ${details.httpStatus}）` : ""}`);
    this.details = details;
    this.retryable = retryable;
    this.name = "WebResearchSecurityError";
    this.code = code;
  }
}

/**
 * 读取公开网页正文，并在每一跳连接前执行网络边界校验。
 */
export class SafeWebClient {
  private readonly dependencies: SafeWebClientDependencies;

  /**
   * @param dependencies 可替换的网络依赖，便于无真实网络的安全测试
   */
  constructor(dependencies: SafeWebClientDependencies = { resolve: resolvePublicAddresses, request: requestBoundedText }) {
    this.dependencies = dependencies;
  }

  /**
   * 获取受配置约束的公开文本响应。
   *
   * @param inputUrl Agent 请求的公开网页地址
   * @param policy 当前联网搜索安全策略
   */
  async fetchText(inputUrl: string, policy: WebResearchConfig, egressProfile: WebResearchEgressProfile = { id: "direct", label: "直接访问", kind: "direct" }, signal?: AbortSignal): Promise<{ finalUrl: string; contentType: "text/html" | "text/plain"; body: string }> {
    const page = await this.fetchResource(inputUrl, policy, egressProfile, signal);
    if (page.contentType === "application/pdf") throw new WebResearchSecurityError("WEB_PDF_DETECTED", { phase: "content_type", contentType: "application/pdf" });
    if ((page.contentType !== "text/html" && page.contentType !== "text/plain") || !policy.allowedContentTypes.includes(page.contentType)) {
      throw new WebResearchSecurityError("WEB_CONTENT_TYPE_BLOCKED", { phase: "content_type", contentType: page.contentType });
    }
    return { ...page, contentType: page.contentType, body: page.body.toString("utf8") };
  }

  /** 下载 PDF 原始字节，共用网页的地址、重定向、出口和资源安全校验。 */
  async fetchPdf(inputUrl: string, policy: WebResearchConfig, egressProfile: WebResearchEgressProfile = { id: "direct", label: "直接访问", kind: "direct" }, signal?: AbortSignal): Promise<{ finalUrl: string; body: Buffer }> {
    const page = await this.fetchResource(inputUrl, policy, egressProfile, signal);
    if (page.contentType !== "application/pdf" || !page.body.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
      throw new WebResearchSecurityError("WEB_CONTENT_TYPE_BLOCKED", { phase: "content_type", contentType: page.contentType });
    }
    return { finalUrl: page.finalUrl, body: page.body };
  }

  /** 全部重定向共用一个截止时间，DNS 和响应流均受取消信号约束。 */
  private async fetchResource(inputUrl: string, policy: WebResearchConfig, egressProfile: WebResearchEgressProfile, externalSignal?: AbortSignal): Promise<{ finalUrl: string; contentType: string; body: Buffer }> {
    const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(policy.webRead.timeoutMs)]) : AbortSignal.timeout(policy.webRead.timeoutMs);
    let current = parseTarget(inputUrl, policy);
    for (let redirects = 0; redirects <= policy.maxRedirects; redirects += 1) {
      signal.throwIfAborted();
      assertAllowedDomain(current.hostname, policy.allowedDomains);
      const addresses = await withAbort(this.dependencies.resolve(current.hostname), signal).catch(() => {
        throw new WebResearchSecurityError(signal.aborted ? "WEB_FETCH_TIMEOUT" : "WEB_DNS_FAILED", { phase: "dns" });
      });
      const address = addresses.find((candidate) => isPublicAddress(candidate))
        ?? (egressProfile.kind === "fake-ip" ? addresses.find((candidate) => isTrustedFakeIp(candidate, egressProfile.fakeIpCidrs)) : undefined);
      if (!address) throw new WebResearchSecurityError("WEB_URL_BLOCKED", { phase: "address" });
      const response = await withAbort(egressProfile.kind === "http-proxy"
        ? requestThroughProxy(current, egressProfile.proxyUrl, policy.maxResponseBytes, signal)
        : this.dependencies.request(current, address, policy.webRead.timeoutMs, policy.maxResponseBytes, signal), signal).catch((error: unknown) => {
        if (error instanceof WebResearchSecurityError) throw error;
        throw new WebResearchSecurityError(signal.aborted ? "WEB_FETCH_TIMEOUT" : "WEB_CONNECTION_FAILED", { phase: "connection" });
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = header(response.headers, "location");
        if (!location) throw new WebResearchSecurityError("WEB_FETCH_FAILED", { phase: "redirect" });
        try { current = parseTarget(new URL(location, current).toString(), policy); }
        catch { throw new WebResearchSecurityError("WEB_URL_BLOCKED", { phase: "redirect" }); }
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new WebResearchSecurityError("WEB_HTTP_ERROR", { phase: "http", httpStatus: response.statusCode }, response.statusCode === 408 || response.statusCode === 429 || response.statusCode >= 500);
      }
      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body, "utf8");
      if (Number(header(response.headers, "content-length")) > policy.maxResponseBytes || body.length > policy.maxResponseBytes) {
        throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE", { phase: "response" });
      }
      const declaredType = header(response.headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "unknown";
      const contentType = ["text/html", "text/plain", "application/pdf"].includes(declaredType) ? declaredType : "other";
      return { finalUrl: current.toString(), contentType, body };
    }
    throw new WebResearchSecurityError("WEB_FETCH_FAILED", { phase: "redirect_limit" });
  }
}

/** 经部署侧代理读取网页；代理凭证只由 Undici 在服务端连接时使用。 */
async function requestThroughProxy(url: URL, proxyUrl: string, maxResponseBytes: number, signal: AbortSignal): Promise<WebResponse> {
  const agent = new ProxyAgent(proxyUrl);
  try {
    const response = await undiciFetch(url, { dispatcher: agent, headers: { accept: "text/html, text/plain;q=0.9, application/pdf;q=0.8" }, signal, redirect: "manual" });
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE");
    const chunks: Buffer[] = [];
    let bytes = 0;
    if (response.body) for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > maxResponseBytes) throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE", { phase: "response" });
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    return { statusCode: response.status, headers: Object.fromEntries(response.headers.entries()), body };
  } finally {
    await agent.close();
  }
}

/** 判断合成地址是否属于当前部署出口登记的 IPv4 网段。 */
function isTrustedFakeIp(address: string, cidrs: string[]): boolean {
  if (isIP(address) !== 4) return false;
  const value = address.split(".").reduce((result, part) => (result << 8) | Number(part), 0) >>> 0;
  return cidrs.some((cidr) => {
    const [network, prefixValue] = cidr.split("/");
    const prefix = Number(prefixValue);
    if (!network || !Number.isInteger(prefix) || prefix < 0 || prefix > 32 || isIP(network) !== 4) return false;
    const base = network.split(".").reduce((result, part) => (result << 8) | Number(part), 0) >>> 0;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) === (base & mask);
  });
}

/** 解析并限制 Agent 传入的目标 URL。 */
function parseTarget(value: string, policy: WebResearchConfig): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebResearchSecurityError("WEB_URL_BLOCKED");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname || url.username || url.password || (policy.httpsOnly && url.protocol !== "https:")) {
    throw new WebResearchSecurityError("WEB_URL_BLOCKED");
  }
  if (isIP(url.hostname) && !isPublicAddress(url.hostname)) throw new WebResearchSecurityError("WEB_URL_BLOCKED");
  return url;
}

/** 判断域名是否符合管理员设置的允许名单。 */
function assertAllowedDomain(hostname: string, allowedDomains: string[]): void {
  if (allowedDomains.length > 0 && !allowedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
    throw new WebResearchSecurityError("WEB_URL_BLOCKED");
  }
}

/** 解析 DNS 并返回全部候选地址。 */
async function resolvePublicAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) return [hostname];
  const [ipv4, ipv6] = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
  return [
    ...(ipv4.status === "fulfilled" ? ipv4.value : []),
    ...(ipv6.status === "fulfilled" ? ipv6.value : []),
  ];
}

/** 使用已通过校验的 DNS 地址建连，避免默认 resolver 重新解析。 */
function requestBoundedText(url: URL, address: string, timeoutMs: number, maxResponseBytes: number, signal?: AbortSignal): Promise<WebResponse> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = transport(url, {
      headers: { accept: "text/html, text/plain;q=0.9, application/pdf;q=0.8" },
      signal,
      lookup: createPinnedLookup(address),
    }, (response) => {
      const contentLength = Number(header(response.headers, "content-length"));
      if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
        response.destroy();
        reject(new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE"));
        return;
      }
      let size = 0;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxResponseBytes) {
          response.destroy(new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new WebResearchSecurityError("WEB_FETCH_TIMEOUT")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * 为已完成安全校验的地址创建 DNS 回调，兼容 Node 24 的多地址查询模式。
 */
export function createPinnedLookup(address: string): LookupFunction {
  const family = isIP(address);
  return (_hostname, options, callback) => {
    // Node 24 在自动选择地址族时要求 all 模式返回地址对象数组。
    if (options.all) {
      callback(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/** 将响应头简化为单一字符串。 */
function header(headers: WebResponse["headers"], name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** 判断 IPv4、IPv6 或 IPv4-mapped IPv6 地址是否可公开访问。 */
function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPublicAddress(normalized.slice(7));
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    return !(normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd"));
  }
  return false;
}

/** 输出不含网络拓扑的错误提示。 */
function errorMessage(code: SecurityErrorCode): string {
  switch (code) {
    case "WEB_URL_BLOCKED": return "该网页地址不符合当前安全策略";
    case "WEB_FETCH_TIMEOUT": return "读取公开资源超出请求时间预算";
    case "WEB_DNS_FAILED": return "读取公开资源时域名解析失败";
    case "WEB_CONNECTION_FAILED": return "读取公开资源时连接建立或响应传输失败";
    case "WEB_HTTP_ERROR": return "公开资源服务器返回非成功状态";
    case "WEB_PDF_DETECTED": return "目标资源是 PDF，网页正文工具不支持该格式";
    case "WEB_RESPONSE_TOO_LARGE": return "网页内容超过当前大小限制";
    case "WEB_CONTENT_TYPE_BLOCKED": return "该网页内容类型不在允许范围内";
    default: return "读取公开资源时重定向或响应处理失败";
  }
}

/** 使 DNS 等不支持 AbortSignal 的依赖也遵守同一截止时间。 */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) { reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}
