import { randomUUID } from "node:crypto";

import type { TtsProfileInput, TtsProfileSummary, TtsSettingsDocument } from "../../shared/tts-contracts";
import { isTtsResponseFormat, normalizeTtsCustomParameters, readTtsCustomParameters } from "../../shared/tts-custom-parameters";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";

interface StoredTtsProfile extends Omit<TtsProfileSummary, "hasApiKey"> {
  apiKey: string;
}

interface StoredTtsSettings {
  profiles: StoredTtsProfile[];
}

type LegacyStoredTtsProfile = Omit<StoredTtsProfile, "customParameters"> & {
  customParameters?: unknown;
};

/** 管理多个 OpenAI 兼容语音配置，并确保读取结果不含密钥。 */
export class TtsConfigService {
  private readonly store;

  /**
   * @param filePath 语音配置的持久化文件路径
   */
  constructor(filePath: string) {
    this.store = createVersionedJsonStore<StoredTtsSettings>(filePath);
  }

  /** 读取全部脱敏配置。 */
  async list(): Promise<TtsSettingsDocument> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    return { revision: loaded.revision, profiles: settings.profiles.map(toSummary) };
  }

  /** 读取服务端内部使用的完整配置。 */
  async getPrivate(id: string): Promise<StoredTtsProfile | undefined> {
    const loaded = await this.store.read();
    return normalizeSettings(loaded.value).profiles.find((profile) => profile.id === id);
  }

  /** 创建一项语音配置。 */
  async create(input: TtsProfileInput): Promise<{ revision: string; profile: TtsProfileSummary }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const profile = normalizeProfile(input, randomUUID());
    const written = await this.store.write({ profiles: [...settings.profiles, profile] }, loaded.revision);
    return { revision: written.revision, profile: toSummary(profile) };
  }

  /** 按版本更新一项语音配置。 */
  async update(id: string, input: TtsProfileInput, revision: string): Promise<{ revision: string; profile: TtsProfileSummary }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const index = settings.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error("语音配置不存在");
    const previous = settings.profiles[index];
    const profile = normalizeProfile({ ...input, apiKey: input.apiKey || previous.apiKey }, id);
    const profiles = [...settings.profiles];
    profiles[index] = profile;
    const written = await this.store.write({ profiles }, revision);
    return { revision: written.revision, profile: toSummary(profile) };
  }

  /** 按版本删除一项语音配置。 */
  async remove(id: string, revision: string): Promise<void> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    if (!settings.profiles.some((profile) => profile.id === id)) throw new Error("语音配置不存在");
    await this.store.write({ profiles: settings.profiles.filter((profile) => profile.id !== id) }, revision);
  }
}

/** 将持久化记录映射成浏览器可见摘要。 */
function toSummary(profile: StoredTtsProfile): TtsProfileSummary {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    voice: profile.voice,
    responseFormat: profile.responseFormat,
    customParameters: profile.customParameters,
    hasApiKey: Boolean(profile.apiKey),
  };
}

/** 兼容缺失或旧格式的配置文件。 */
function normalizeSettings(value: unknown): StoredTtsSettings {
  if (!isRecord(value) || !Array.isArray(value.profiles)) return { profiles: [] };
  return {
    profiles: value.profiles
      .map(normalizeStoredProfile)
      .filter((profile): profile is StoredTtsProfile => profile !== undefined),
  };
}

/** 校验用户提交的单项配置。 */
function normalizeProfile(input: TtsProfileInput, id: string): StoredTtsProfile {
  const name = normalizeText(input.name, "配置名称", 80);
  const model = normalizeText(input.model, "模型名称", 160);
  const voice = normalizeText(input.voice, "音色", 160);
  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new TypeError("请填写 API Key");
  if (!isTtsResponseFormat(input.responseFormat)) throw new TypeError("语音格式无效");
  const customParameters = normalizeTtsCustomParameters(input.customParameters ?? {});
  return { id, name, baseUrl: normalizeBaseUrl(input.baseUrl), model, voice, responseFormat: input.responseFormat, customParameters, apiKey };
}

/** 统一校验第三方 OpenAI 兼容服务地址。 */
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

/** 校验有限长度的必填文本。 */
function normalizeText(value: string, label: string, maximum: number): string {
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${label}长度无效`);
  return text;
}

function isStoredProfile(value: unknown): value is LegacyStoredTtsProfile {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.baseUrl === "string"
    && typeof value.model === "string"
    && typeof value.voice === "string"
    && typeof value.apiKey === "string"
    && isTtsResponseFormat(value.responseFormat);
}

/** 将旧版持久化记录补齐为当前完整结构。 */
function normalizeStoredProfile(value: unknown): StoredTtsProfile | undefined {
  if (!isStoredProfile(value)) return undefined;
  const { customParameters, ...profile } = value;
  return { ...profile, customParameters: readTtsCustomParameters(customParameters) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
