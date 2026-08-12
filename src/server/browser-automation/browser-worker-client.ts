import { createHash, createHmac, randomUUID } from "node:crypto";

import type {
  BrowserCommand,
  BrowserWorkerResponse,
  CreateBrowserContextRequest,
} from "../../shared/browser-worker-protocol";
import { BrowserAutomationError, type BrowserAutomationErrorCode } from "./browser-error";

const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

/** Worker client 的可测试依赖。 */
export interface BrowserWorkerClientOptions {
  /** 仅部署侧提供的内部基础地址。 */
  baseUrl: string;
  /** 仅进程内使用的 HMAC 密钥。 */
  secret: string;
  /** 可注入的 Fetch 实现。 */
  fetch?: typeof globalThis.fetch;
  /** 可注入的当前时间。 */
  now?: () => number;
  /** 可注入的请求 nonce。 */
  nonce?: () => string;
}

/** 经 HMAC 认证访问浏览器 Worker 的有界客户端。 */
export class BrowserWorkerClient {
  /** 规范化后的内部基础地址。 */
  private readonly baseUrl: string;
  /** 内部请求签名密钥。 */
  private readonly secret: string;
  /** Fetch 实现。 */
  private readonly fetch: typeof globalThis.fetch;
  /** 当前时间函数。 */
  private readonly now: () => number;
  /** nonce 生成函数。 */
  private readonly nonce: () => string;

  /** 创建 Worker client。 */
  constructor(options: BrowserWorkerClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, "");
    this.secret = options.secret;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? randomUUID;
  }

  /** 检查 Worker 和 Chromium 的非敏感健康状态。 */
  health(signal?: AbortSignal): Promise<unknown> {
    return this.request("GET", "/healthz", undefined, signal);
  }

  /** 创建与 Browser Run Lease 绑定的 Context。 */
  createContext(input: CreateBrowserContextRequest, signal?: AbortSignal): Promise<{ contextId: string }> {
    return this.request("POST", "/v1/contexts", input, signal);
  }

  /** 在现有 Context 中执行单个原子命令。 */
  execute<Data>(leaseId: string, command: BrowserCommand, signal?: AbortSignal): Promise<Data> {
    return this.request("POST", `/v1/contexts/${encodeURIComponent(leaseId)}/commands`, { leaseId, command }, signal);
  }

  /** 关闭 Context；Worker 应将该操作视为幂等。 */
  async closeContext(leaseId: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/v1/contexts/${encodeURIComponent(leaseId)}`, undefined, signal);
  }

  /** 签名并解析一个有界 JSON 请求。 */
  private async request<Data>(method: string, path: string, input?: unknown, signal?: AbortSignal): Promise<Data> {
    const body = input === undefined ? "" : JSON.stringify(input);
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const contentHash = createHash("sha256").update(body).digest("hex");
    const canonical = `${method}\n${path}\n${timestamp}\n${nonce}\n${contentHash}`;
    const signature = createHmac("sha256", this.secret).update(canonical).digest("hex");
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          "content-type": "application/json",
          "x-bugpaw-timestamp": timestamp,
          "x-bugpaw-nonce": nonce,
          "x-bugpaw-content-sha256": contentHash,
          "x-bugpaw-signature": signature,
        },
        ...(body ? { body } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new BrowserAutomationError("BROWSER_WORKER_UNAVAILABLE", "浏览器执行服务暂时不可用", true);
    }

    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_RESPONSE_BYTES) throw protocolError();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_JSON_RESPONSE_BYTES) throw protocolError();
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw protocolError();
    }
    if (!isWorkerResponse(payload)) throw protocolError();
    if (payload.status === "error") {
      throw new BrowserAutomationError(
        normalizeWorkerErrorCode(payload.error.code),
        payload.error.message,
        payload.error.retryable,
      );
    }
    if (!response.ok) throw protocolError();
    return payload.data as Data;
  }
}

/** 创建不泄露响应正文的协议错误。 */
function protocolError(): BrowserAutomationError {
  return new BrowserAutomationError("BROWSER_WORKER_PROTOCOL_INVALID", "浏览器执行服务返回了无效响应", true);
}

/** 判断未知 JSON 是否满足 Worker 响应信封。 */
function isWorkerResponse(value: unknown): value is BrowserWorkerResponse {
  if (!isRecord(value) || (value.status !== "ok" && value.status !== "error")) return false;
  if (value.status === "ok") return "data" in value;
  return isRecord(value.error)
    && typeof value.error.code === "string"
    && typeof value.error.message === "string"
    && typeof value.error.retryable === "boolean";
}

/** Worker 未知错误码统一收敛为协议错误，避免扩散未审计协议。 */
function normalizeWorkerErrorCode(value: string): BrowserAutomationErrorCode {
  const allowed: BrowserAutomationErrorCode[] = [
    "BROWSER_CONTEXT_EXPIRED",
    "BROWSER_CONTEXT_NOT_OPEN",
    "BROWSER_WORKER_UNAVAILABLE",
    "BROWSER_NAVIGATION_TIMEOUT",
    "BROWSER_DOWNLOAD_BLOCKED",
    "BROWSER_DOWNLOAD_TOO_LARGE",
    "BROWSER_ELEMENT_REFERENCE_STALE",
    "BROWSER_HARD_SAFETY_BLOCKED",
  ];
  return allowed.includes(value as BrowserAutomationErrorCode)
    ? value as BrowserAutomationErrorCode
    : "BROWSER_WORKER_PROTOCOL_INVALID";
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
