import type { EmbeddingConfigInput, EmbeddingConfigSummary, EmbeddingSettingsDocument } from "../../shared/knowledge-retrieval-contracts";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";

interface StoredEmbeddingConfig extends Omit<EmbeddingConfigSummary, "hasApiKey"> {
  apiKey: string;
}

/** 受管 Embedding 服务在当前部署中的可用性。 */
export interface EmbeddingConfigServiceOptions {
  /** 是否随当前部署提供内部 Embedding 服务。 */
  managedAvailable?: boolean;
}

/** 部署随附的中文 Embedding 服务默认配置。 */
const MANAGED_EMBEDDING_CONFIG: StoredEmbeddingConfig = {
  baseUrl: "http://bug-paw-embedding:80/v1",
  model: "BAAI/bge-small-zh-v1.5",
  batchSize: 8,
  apiKey: "",
  isManaged: true,
  enabled: true,
};

/** 管理单一 Embedding 配置，并隔离仅服务端可读的密钥。 */
export class EmbeddingConfigService {
  private readonly store;

  /** 当前部署对应的受管默认配置。 */
  private readonly managedConfig: StoredEmbeddingConfig;

  /**
   * @param filePath Embedding 配置的持久化文件路径
   * @param options 当前部署提供的托管能力
   */
  constructor(filePath: string, options: EmbeddingConfigServiceOptions = {}) {
    this.store = createVersionedJsonStore<StoredEmbeddingConfig>(filePath);
    this.managedConfig = {
      ...MANAGED_EMBEDDING_CONFIG,
      enabled: options.managedAvailable ?? true,
    };
  }

  /** 读取当前脱敏配置；首次使用时没有配置。 */
  async read(): Promise<EmbeddingSettingsDocument> {
    const loaded = await this.store.read();
    if (loaded.value === undefined) return { revision: loaded.revision, config: toSummary(this.managedConfig) };
    const config = normalizeStoredConfig(loaded.value, this.managedConfig);
    return { revision: loaded.revision, ...(config ? { config: toSummary(config) } : {}) };
  }

  /** 读取服务端内部使用的完整配置。 */
  async getPrivate(): Promise<StoredEmbeddingConfig | undefined> {
    const loaded = await this.store.read();
    return loaded.value === undefined ? this.managedConfig : normalizeStoredConfig(loaded.value, this.managedConfig);
  }

  /** 在版本匹配时保存唯一的 Embedding 配置。 */
  async update(input: EmbeddingConfigInput, revision: string): Promise<EmbeddingSettingsDocument> {
    const loaded = await this.store.read();
    const previous = loaded.value === undefined ? this.managedConfig : normalizeStoredConfig(loaded.value, this.managedConfig);
    const config = isManagedInput(input, this.managedConfig) && previous?.isManaged
      ? { ...this.managedConfig, enabled: this.managedConfig.enabled && input.enabled !== false }
      : normalizeInput({ ...input, apiKey: input.apiKey || previous?.apiKey || "" });
    const written = await this.store.write(config, revision);
    return { revision: written.revision, config: toSummary(config) };
  }
}

/** 映射出不含 API Key 的浏览器可见模型。 */
function toSummary(config: StoredEmbeddingConfig): EmbeddingConfigSummary {
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    batchSize: config.batchSize,
    hasApiKey: Boolean(config.apiKey),
    isManaged: config.isManaged,
    enabled: config.enabled,
  };
}

/** 将未知持久化数据收敛成合法配置。 */
function normalizeStoredConfig(value: unknown, managedConfig: StoredEmbeddingConfig): StoredEmbeddingConfig | undefined {
  if (!isRecord(value)
    || typeof value.baseUrl !== "string"
    || typeof value.model !== "string"
    || typeof value.batchSize !== "number"
    || typeof value.apiKey !== "string") return undefined;
  const input = { ...(value as unknown as EmbeddingConfigInput), enabled: value.enabled !== false };
  if (value.isManaged === true && isManagedInput(input, managedConfig)) {
    return { ...managedConfig, enabled: managedConfig.enabled && input.enabled };
  }
  return normalizeInput(input);
}

/** 仅允许部署随附模型在无密钥时保留受管身份。 */
function isManagedInput(input: EmbeddingConfigInput, managedConfig: StoredEmbeddingConfig): boolean {
  return input.apiKey.trim() === ""
    && normalizeBaseUrl(input.baseUrl) === normalizeBaseUrl(managedConfig.baseUrl)
    && input.model.trim() === managedConfig.model
    && input.batchSize === managedConfig.batchSize;
}

/** 校验单一 Embedding 配置的请求字段。 */
function normalizeInput(input: EmbeddingConfigInput): StoredEmbeddingConfig {
  const model = input.model.trim();
  if (!model || model.length > 160) throw new TypeError("模型名称长度无效");
  if (!Number.isInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 128) {
    throw new TypeError("批量大小必须在 1 到 128 之间");
  }
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new TypeError("请填写 API Key");
  return {
    baseUrl: normalizeBaseUrl(input.baseUrl),
    model,
    batchSize: input.batchSize,
    apiKey,
    isManaged: false,
    enabled: input.enabled !== false,
  };
}

/** 校验 OpenAI 兼容 Embedding 服务地址。 */
function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("服务地址格式无效");
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new TypeError("服务地址必须不含凭证、查询参数或片段");
  }
  return url.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
