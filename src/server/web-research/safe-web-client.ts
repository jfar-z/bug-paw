import { resolve4, resolve6 } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { ProxyAgent, fetch as undiciFetch } from "undici";

import type { WebResearchConfig } from "../../shared/web-research-contracts";
import type { WebResearchEgressProfile } from "../../shared/web-research-egress-contracts";

type SecurityErrorCode = "WEB_URL_BLOCKED" | "WEB_FETCH_TIMEOUT" | "WEB_RESPONSE_TOO_LARGE" | "WEB_CONTENT_TYPE_BLOCKED" | "WEB_FETCH_FAILED";

interface WebResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface SafeWebClientDependencies {
  resolve(hostname: string): Promise<string[]>;
  request(url: URL, address: string, timeoutMs: number, maxResponseBytes: number): Promise<WebResponse>;
}

/**
 * 以稳定、可纠正的文案返回联网安全错误。
 */
export class WebResearchSecurityError extends Error {
  /** 供工具与接口识别的安全错误代码。 */
  readonly code: SecurityErrorCode;

  /**
   * @param code 安全错误代码
   * @param _detail 仅供调用处保留错误上下文，绝不回显给 Agent 或客户端
   */
  constructor(code: SecurityErrorCode, _detail?: string) {
    super(errorMessage(code));
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
  async fetchText(inputUrl: string, policy: WebResearchConfig, egressProfile: WebResearchEgressProfile = { id: "direct", label: "直接访问", kind: "direct" }): Promise<{ finalUrl: string; contentType: "text/html" | "text/plain"; body: string }> {
    let current = parseTarget(inputUrl, policy);
    for (let redirects = 0; redirects <= policy.maxRedirects; redirects += 1) {
      assertAllowedDomain(current.hostname, policy.allowedDomains);
      const addresses = await this.dependencies.resolve(current.hostname).catch(() => { throw new WebResearchSecurityError("WEB_FETCH_FAILED"); });
      const address = addresses.find((candidate) => isPublicAddress(candidate))
        ?? (egressProfile.kind === "fake-ip" ? addresses.find((candidate) => isTrustedFakeIp(candidate, egressProfile.fakeIpCidrs)) : undefined);
      if (!address) throw new WebResearchSecurityError("WEB_URL_BLOCKED");
      const response = await (egressProfile.kind === "http-proxy"
        ? requestThroughProxy(current, egressProfile.proxyUrl, policy.webRead.timeoutMs, policy.maxResponseBytes)
        : this.dependencies.request(current, address, policy.webRead.timeoutMs, policy.maxResponseBytes)).catch((error: unknown) => {
        if (error instanceof WebResearchSecurityError) throw error;
        throw new WebResearchSecurityError("WEB_FETCH_FAILED");
      });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = header(response.headers, "location");
        if (!location) throw new WebResearchSecurityError("WEB_FETCH_FAILED");
        current = parseTarget(new URL(location, current).toString(), policy);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) throw new WebResearchSecurityError("WEB_FETCH_FAILED");
      const declaredLength = Number(header(response.headers, "content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > policy.maxResponseBytes) throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE");
      const contentType = normalizeContentType(header(response.headers, "content-type"));
      if (contentType === "other" || !policy.allowedContentTypes.includes(contentType)) throw new WebResearchSecurityError("WEB_CONTENT_TYPE_BLOCKED");
      if (Buffer.byteLength(response.body, "utf8") > policy.maxResponseBytes) throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE");
      return { finalUrl: current.toString(), contentType, body: response.body };
    }
    throw new WebResearchSecurityError("WEB_FETCH_FAILED");
  }
}

/** 经部署侧代理读取网页；代理凭证只由 Undici 在服务端连接时使用。 */
async function requestThroughProxy(url: URL, proxyUrl: string, timeoutMs: number, maxResponseBytes: number): Promise<WebResponse> {
  const agent = new ProxyAgent(proxyUrl);
  try {
    const response = await undiciFetch(url, { dispatcher: agent, headers: { accept: "text/html, text/plain;q=0.9" }, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE");
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > maxResponseBytes) throw new WebResearchSecurityError("WEB_RESPONSE_TOO_LARGE");
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
function requestBoundedText(url: URL, address: string, timeoutMs: number, maxResponseBytes: number): Promise<WebResponse> {
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = transport(url, {
      headers: { accept: "text/html, text/plain;q=0.9" },
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
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
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

/** 归一化允许的媒体类型。 */
function normalizeContentType(value: string | undefined): "text/html" | "text/plain" | "other" {
  const type = value?.split(";", 1)[0]?.trim().toLowerCase();
  return type === "text/html" || type === "text/plain" ? type : "other";
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
    case "WEB_FETCH_TIMEOUT": return "联网页面请求超时，请稍后重试";
    case "WEB_RESPONSE_TOO_LARGE": return "网页内容超过当前大小限制";
    case "WEB_CONTENT_TYPE_BLOCKED": return "该网页内容类型不在允许范围内";
    default: return "无法读取该公开网页，请稍后重试";
  }
}
