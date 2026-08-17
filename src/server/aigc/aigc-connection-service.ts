import type {
  AigcChannelConfig,
  AigcChannelInput,
  AigcChannelSummary,
  AigcChannelType,
} from "../../shared/aigc-contracts";
import { AIGC_CHANNEL_TYPES } from "../../shared/aigc-contracts";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";

interface StoredAigcSettings {
  channels: AigcChannelConfig[];
}

interface AigcConnectionDocument {
  revision: string;
  channels: AigcChannelConfig[];
}

/** 管理 AIGC 渠道的非敏感配置文件。 */
export class AigcConnectionService {
  private readonly store;

  /**
   * @param filePath AIGC 渠道配置文件路径
   */
  constructor(filePath: string) {
    this.store = createVersionedJsonStore<StoredAigcSettings>(filePath);
  }

  /** 读取当前渠道配置文档。 */
  async read(): Promise<AigcConnectionDocument> {
    const loaded = await this.store.read();
    return {
      revision: loaded.revision,
      channels: normalizeSettings(loaded.value).channels,
    };
  }

  /** 读取全部脱敏渠道摘要。 */
  async list(): Promise<AigcConnectionDocument> {
    return this.read();
  }

  /** 校验浏览器输入并生成规范渠道配置。 */
  async validate(input: AigcChannelInput, id?: string): Promise<AigcChannelConfig> {
    return normalizeChannel(input, id);
  }

  /** 创建渠道配置。 */
  async create(input: AigcChannelInput, id: string, revision: string): Promise<AigcConnectionDocument> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    if (settings.channels.some((channel) => channel.id === id)) throw new TypeError("AIGC 渠道标识重复");
    const channel = await this.validate(input, id);
    const written = await this.store.write({ channels: [...settings.channels, channel] }, revision);
    return { revision: written.revision, channels: normalizeSettings(written.value).channels };
  }

  /** 更新渠道配置。 */
  async update(id: string, input: AigcChannelInput, revision: string): Promise<AigcConnectionDocument> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const index = settings.channels.findIndex((channel) => channel.id === id);
    if (index < 0) throw new TypeError("AIGC 渠道不存在");
    const channel = await this.validate(input, id);
    const channels = [...settings.channels];
    channels[index] = channel;
    const written = await this.store.write({ channels }, revision);
    return { revision: written.revision, channels: normalizeSettings(written.value).channels };
  }

  /** 删除渠道配置。 */
  async remove(id: string, revision: string): Promise<void> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    if (!settings.channels.some((channel) => channel.id === id)) throw new TypeError("AIGC 渠道不存在");
    await this.store.write({ channels: settings.channels.filter((channel) => channel.id !== id) }, revision);
  }
}

/** 将持久化记录映射成浏览器可见摘要。 */
export function toAigcChannelSummary(channel: AigcChannelConfig, hasApiKey: boolean): AigcChannelSummary {
  return { ...channel, hasApiKey };
}

/** 兼容缺失或旧格式的配置文件。 */
function normalizeSettings(value: unknown): StoredAigcSettings {
  if (!isRecord(value) || !Array.isArray(value.channels)) return { channels: [] };
  return {
    channels: value.channels
      .filter(isStoredChannel)
      .map((channel) => ({ ...channel })),
  };
}

/** 校验并归一化用户提交的渠道配置。 */
async function normalizeChannel(input: AigcChannelInput, id?: string): Promise<AigcChannelConfig> {
  const name = normalizeText(input.name, "渠道名称", 80);
  const type = input.type;
  if (!AIGC_CHANNEL_TYPES.includes(type)) throw new TypeError("AIGC 渠道类型无效");
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const enabled = input.enabled;
  if (typeof enabled !== "boolean") throw new TypeError("启用状态必须是布尔值");
  const timeoutMs = readInteger(input.timeoutMs, "请求超时", 1_000, 300_000, 30_000);
  if (!id || !validId(id)) throw new TypeError("AIGC 渠道 ID 格式无效");
  return { id, name, type, baseUrl, enabled, timeoutMs };
}

/** 校验允许内网访问且不带凭证的 HTTP(S) 地址。 */
export function normalizeAigcBaseUrl(value: string): string {
  return normalizeBaseUrl(value);
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new TypeError("服务地址格式无效");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new TypeError("服务地址必须不含凭证、查询参数或片段");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizeText(value: string, label: string, maximum: number): string {
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${label}长度无效`);
  return text;
}

function readInteger(value: number, label: string, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) return fallback;
  return value;
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function isStoredChannel(value: unknown): value is AigcChannelConfig {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && AIGC_CHANNEL_TYPES.includes(value.type as AigcChannelType)
    && typeof value.baseUrl === "string"
    && typeof value.enabled === "boolean"
    && typeof value.timeoutMs === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
