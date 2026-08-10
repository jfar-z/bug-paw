import type { CredentialService } from "./configuration/credential-service";
import type { ModelConfigService } from "./configuration/model-config-service";
import { SYSTEM_LIMITS } from "./core/limits";

/**
 * 远端模型目录中的单个模型。
 */
export interface DiscoveredModel {
  id: string;
  name: string;
  exists: boolean;
}

/**
 * Provider 模型发现结果。
 */
export interface DiscoverModelsResult {
  providerId: string;
  models: DiscoveredModel[];
}

type ProviderModelDiscoveryErrorCode =
  | "PROVIDER_NOT_FOUND"
  | "UNSUPPORTED_PROVIDER_API"
  | "MODEL_DISCOVERY_IN_PROGRESS"
  | "INVALID_PROVIDER_BASE_URL"
  | "MODEL_DISCOVERY_TIMEOUT"
  | "MODEL_DISCOVERY_FAILED";

/**
 * 模型目录发现可预期的业务错误。
 */
export class ProviderModelDiscoveryError extends Error {
  /**
   * 创建稳定且不含凭证的发现错误。
   *
   * @param code 机器可读错误码
   * @param message 面向调用方的安全消息
   */
  constructor(
    readonly code: ProviderModelDiscoveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProviderModelDiscoveryError";
  }
}

/**
 * Provider 模型目录发现能力。
 */
export interface ProviderModelDiscovery {
  /**
   * 从保存的 Provider 配置中发现远端模型。
   *
   * @param providerId Provider 标识
   */
  discover(providerId: string): Promise<DiscoverModelsResult>;
}

/**
 * 模型发现服务依赖。
 */
export interface ProviderModelDiscoveryOptions {
  models: ModelConfigService;
  credentials: CredentialService;
  fetch?: typeof globalThis.fetch;
}

type ProviderNode = Record<string, unknown>;

const supportedApis = new Set(["openai-completions", "openai-responses"]);

/**
 * 创建基于已保存 Provider 配置的模型发现服务。
 *
 * @param options 模型配置、凭证与可替换请求实现
 */
export function createProviderModelDiscovery(options: ProviderModelDiscoveryOptions): ProviderModelDiscovery {
  const discoveringProviders = new Set<string>();
  const fetchImplementation = options.fetch ?? globalThis.fetch;

  return {
    async discover(providerId) {
      if (discoveringProviders.has(providerId)) {
        throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_IN_PROGRESS", "该 Provider 正在发现模型");
      }
      discoveringProviders.add(providerId);
      try {
        const document = await options.models.read();
        const providers = isRecord(document.value.providers) ? document.value.providers : {};
        const provider = providers[providerId];
        if (!isRecord(provider)) {
          throw new ProviderModelDiscoveryError("PROVIDER_NOT_FOUND", "Provider 不存在");
        }
        if (typeof provider.api !== "string" || !supportedApis.has(provider.api)) {
          throw new ProviderModelDiscoveryError("UNSUPPORTED_PROVIDER_API", "该 Provider 协议不支持模型发现");
        }
        if (typeof provider.baseUrl !== "string" || !provider.baseUrl.trim()) {
          throw new ProviderModelDiscoveryError("INVALID_PROVIDER_BASE_URL", "Provider Base URL 无效");
        }

        const url = modelsEndpoint(provider.baseUrl);
        const headers = await requestHeaders(provider, providerId, options.credentials);
        const requestSecrets = collectRequestSecrets(url, headers);
        const response = await fetchModels(fetchImplementation, url, headers);
        if (!response.ok) {
          throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_FAILED", "模型目录请求失败");
        }
        const payload = await readPayload(response);
        const existingIds = existingModelIds(provider.models);
        const ids = discoveredIds(payload).filter((id) => !containsRequestSecret(id, requestSecrets));
        return {
          providerId,
          models: ids.map((id) => ({ id, name: id, exists: existingIds.has(id) })),
        };
      } catch (error) {
        if (error instanceof ProviderModelDiscoveryError) throw error;
        if (isTimeoutError(error)) {
          throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_TIMEOUT", "模型目录请求超时");
        }
        throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_FAILED", safeFailureMessage(error));
      } finally {
        discoveringProviders.delete(providerId);
      }
    },
  };
}

/**
 * 将保存的 Base URL 变换为 OpenAI 兼容模型目录地址。
 *
 * @param baseUrl 保存的 Provider 基础地址
 */
function modelsEndpoint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/u, "");
    url.pathname = path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    throw new ProviderModelDiscoveryError("INVALID_PROVIDER_BASE_URL", "Provider Base URL 无效");
  }
}

/**
 * 组合保存的自定义请求头与 API Key 认证头。
 *
 * @param provider 保存的 Provider 节点
 * @param providerId Provider 标识
 * @param credentials 凭证读取服务
 */
async function requestHeaders(
  provider: ProviderNode,
  providerId: string,
  credentials: CredentialService,
): Promise<Record<string, string>> {
  const headers = stringHeaders(provider.headers);
  const hasAuthorization = Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
  if (provider.authHeader !== false && !hasAuthorization) {
    const apiKey = await credentials.getApiKey(providerId);
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * 发起具备请求超时与硬截止的模型目录请求。
 *
 * @param fetchImplementation 可注入的 Fetch 实现
 * @param url 模型目录地址
 * @param headers 已脱离浏览器输入的请求头
 */
async function fetchModels(
  fetchImplementation: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Response> {
  const controller = new AbortController();
  const requestTimer = setTimeout(() => controller.abort(), 20_000);
  let hardTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<never>((_resolve, reject) => {
    hardTimer = setTimeout(() => reject(new ModelDiscoveryTimeoutError()), 22_000);
  });
  try {
    return await Promise.race([
      fetchImplementation(url, { method: "GET", headers, signal: controller.signal }),
      hardDeadline,
    ]);
  } finally {
    clearTimeout(requestTimer);
    if (hardTimer) clearTimeout(hardTimer);
  }
}

/**
 * 安全读取 OpenAI 兼容响应主体。
 *
 * @param response 远端响应
 */
async function readPayload(response: Response): Promise<unknown> {
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const bodyDeadline = new Promise<never>((_resolve, reject) => {
    bodyTimer = setTimeout(() => reject(new ModelDiscoveryTimeoutError()), 20_000);
  });
  try {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > SYSTEM_LIMITS.modelDiscoveryResponseBytes) throw new Error("response too large");
    if (!response.body) {
      return JSON.parse(await Promise.race([response.text(), bodyDeadline])) as unknown;
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), bodyDeadline]);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > SYSTEM_LIMITS.modelDiscoveryResponseBytes) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(value);
    }
    const merged = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(merged)) as unknown;
  } catch (error) {
    if (isTimeoutError(error)) {
      await reader?.cancel().catch(() => undefined);
      throw error;
    }
    throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_FAILED", "模型目录请求失败");
  } finally {
    if (bodyTimer) clearTimeout(bodyTimer);
  }
}

/**
 * 提取远端返回中的可用模型 ID。
 *
 * @param payload 远端 JSON 响应
 */
function discoveredIds(payload: unknown): string[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_FAILED", "模型目录请求失败");
  }
  if (payload.data.length > SYSTEM_LIMITS.modelDiscoveryModels) throw new ProviderModelDiscoveryError("MODEL_DISCOVERY_FAILED", "模型目录返回条目过多");
  return [...new Set(payload.data.flatMap((item) => isRecord(item) && typeof item.id === "string" && item.id.trim() && [...item.id].length <= SYSTEM_LIMITS.modelDiscoveryModelIdCharacters ? [item.id] : []))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * 提取当前已保存的模型 ID，用于发现结果去重提示。
 *
 * @param models Provider 模型配置
 */
function existingModelIds(models: unknown): Set<string> {
  if (!Array.isArray(models)) return new Set();
  return new Set(models.flatMap((model) => isRecord(model) && typeof model.id === "string" ? [model.id] : []));
}

/**
 * 仅保留 Provider 配置中的字符串请求头。
 *
 * @param value 保存的 Headers 节点
 */
function stringHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/**
 * 判断未知值是否为普通记录对象。
 *
 * @param value 待判断值
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ModelDiscoveryTimeoutError extends Error {
  constructor() {
    super("模型目录请求超时");
  }
}

/**
 * 判断是否为取消或硬截止超时。
 *
 * @param error 原始异常
 */
function isTimeoutError(error: unknown): boolean {
  return error instanceof ModelDiscoveryTimeoutError
    || (error instanceof Error && error.name === "AbortError");
}

/**
 * 清洗网络异常中的潜在凭证，保留短小可读的故障上下文。
 *
 * @param error 原始异常
 */
function safeFailureMessage(error: unknown): string {
  // 网络栈和恶意 Provider 都可能裸回显实际请求凭证，统一使用固定公开错误。
  void error;
  return "模型目录请求失败";
}

/** 收集远端实际可见的 Header 与 URL 用户信息，用于阻断裸凭证伪装成模型 ID。 */
function collectRequestSecrets(urlValue: string, headers: Record<string, string>): Set<string> {
  const secrets = new Set<string>();
  for (const value of Object.values(headers)) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    secrets.add(trimmed);
    const scheme = /^(?:basic|bearer|token)\s+(.+)$/iu.exec(trimmed);
    if (scheme?.[1]) secrets.add(scheme[1]);
  }
  const url = new URL(urlValue);
  for (const value of [url.username, url.password]) {
    if (!value) continue;
    secrets.add(value);
    try { secrets.add(decodeURIComponent(value)); } catch { /* 非法编码保持原值参与过滤。 */ }
  }
  return secrets;
}

/** 精确值始终过滤，长度足够的凭证也不得作为模型 ID 子串返回。 */
function containsRequestSecret(modelId: string, secrets: ReadonlySet<string>): boolean {
  return [...secrets].some((secret) => modelId === secret || (secret.length >= 4 && modelId.includes(secret)));
}
