import { createVersionedJsonStore } from "../configuration/versioned-json-store";
import {
  DEFAULT_WEB_RESEARCH_CONFIG,
  type SearchProviderConfig,
  type WebResearchConfig,
  type WebResearchConfigDocument,
} from "../../shared/web-research-contracts";
import { EgressProfileRegistry } from "./egress-profile-registry";
import { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";

const LEGACY_MANAGED_URLS = new Set(["http://bug-paw-search:8080", "http://searxng:8080"]);

/** 提供联网搜索配置的版本化读写、旧结构迁移和输入校验。 */
export class WebResearchConfigService {
  private readonly store;

  constructor(
    filePath: string,
    private readonly egressProfiles = new EgressProfileRegistry(),
    private readonly managedProviders = new ManagedSearchProviderRegistry(false),
  ) {
    this.store = createVersionedJsonStore<unknown>(filePath);
  }

  /** 读取当前配置；首次使用时根据部署能力返回保守默认值。 */
  async read(): Promise<WebResearchConfigDocument> {
    const loaded = await this.store.read();
    const config = loaded.value === undefined ? this.defaultConfig() : normalizeConfig(loaded.value, this.managedProviders);
    return { revision: loaded.revision, config };
  }

  /** 在 revision 匹配时保存完整配置。 */
  async update(input: WebResearchConfig, revision: string): Promise<WebResearchConfigDocument> {
    const config = await this.validate(input);
    const written = await this.store.write(config, revision);
    return { revision: written.revision, config };
  }

  /** 供多文件事务在写入前复用完整配置校验。 */
  async validate(input: WebResearchConfig): Promise<WebResearchConfig> {
    const config = normalizeConfig(input, this.managedProviders);
    await this.validateEgressProfiles(config);
    return config;
  }

  /** 把旧单 SearXNG 结构一次性写成多实例结构；新结构重复执行不产生写入。 */
  async migrateLegacyConfig(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = await this.store.read();
      if (loaded.value === undefined || isNewConfig(loaded.value)) return;
      const config = normalizeConfig(loaded.value, this.managedProviders);
      try {
        await this.store.write(config, loaded.revision);
        return;
      } catch (error) {
        // 管理员并发保存时只重读一次，避免覆盖已经迁移或更新的配置。
        if (attempt === 1) throw error;
      }
    }
  }

  private defaultConfig(): WebResearchConfig {
    const managed = this.managedProviders.listTemplates()[0];
    return cloneConfig({
      ...DEFAULT_WEB_RESEARCH_CONFIG,
      searchProviders: managed ? [{ ...managed, enabled: true, timeoutMs: 10_000 }] : [],
    });
  }

  private async validateEgressProfiles(config: WebResearchConfig): Promise<void> {
    await this.egressProfiles.require(config.webRead.egressProfileId);
    for (const provider of config.searchProviders) {
      if (provider.egressProfileId) await this.egressProfiles.require(provider.egressProfileId);
    }
  }
}

/** 深复制数组与嵌套字段，避免调用方修改共享默认对象。 */
function cloneConfig(config: WebResearchConfig): WebResearchConfig {
  return {
    ...config,
    searchProviders: config.searchProviders.map((provider) => ({ ...provider })),
    webRead: { ...config.webRead },
    allowedDomains: [...config.allowedDomains],
    allowedContentTypes: [...config.allowedContentTypes],
  };
}

/** 校验并归一化新旧两代管理员配置。 */
function normalizeConfig(value: unknown, managedProviders: ManagedSearchProviderRegistry): WebResearchConfig {
  if (!isRecord(value)) throw new TypeError("联网搜索配置必须是对象");
  const config = value as Record<string, unknown>;
  if (typeof config.enabled !== "boolean") throw new TypeError("启用状态必须是布尔值");
  if (typeof config.httpsOnly !== "boolean") throw new TypeError("HTTPS 策略必须是布尔值");

  const searchProviders = isNewConfig(config)
    ? normalizeProviders(config.searchProviders, managedProviders)
    : migrateLegacyProvider(config, managedProviders);
  if (config.enabled && !searchProviders.some((provider) => provider.enabled)) {
    throw new TypeError("启用联网搜索前至少配置一个可用搜索服务");
  }

  const legacyTimeout = readInteger(config.timeoutMs, "请求超时", 1_000, 60_000, true) ?? 10_000;
  const webReadSource = isRecord(config.webRead) ? config.webRead : {};
  return {
    enabled: config.enabled,
    searchProviders,
    webRead: {
      egressProfileId: normalizeEgressProfileId(webReadSource.egressProfileId ?? config.egressProfileId),
      timeoutMs: readInteger(webReadSource.timeoutMs, "页面读取超时", 1_000, 60_000, true) ?? legacyTimeout,
    },
    maxResults: readInteger(config.maxResults, "搜索结果数", 1, 20),
    maxTextLength: readInteger(config.maxTextLength, "正文长度", 1_000, 100_000),
    maxRedirects: readInteger(config.maxRedirects, "重定向次数", 0, 10),
    maxResponseBytes: readInteger(config.maxResponseBytes, "响应体大小", 64 * 1024, 10 * 1024 * 1024),
    httpsOnly: config.httpsOnly,
    allowedDomains: normalizeDomains(config.allowedDomains),
    allowedContentTypes: normalizeContentTypes(config.allowedContentTypes),
  };
}

function isNewConfig(value: unknown): value is Record<string, unknown> & { searchProviders: unknown[] } {
  return isRecord(value) && Array.isArray(value.searchProviders);
}

/** 将旧单实例结构转换成受管或自定义 SearXNG。 */
function migrateLegacyProvider(config: Record<string, unknown>, managedProviders: ManagedSearchProviderRegistry): SearchProviderConfig[] {
  const baseUrl = normalizeBaseUrl(config.searxngBaseUrl);
  const timeoutMs = readInteger(config.timeoutMs, "请求超时", 1_000, 60_000);
  const managedAvailable = managedProviders.listTemplates().some((template) => template.id === "managed-searxng");
  if (managedAvailable && LEGACY_MANAGED_URLS.has(baseUrl)) {
    return [{ id: "managed-searxng", name: "内置 SearXNG", type: "searxng", connectionMode: "managed", enabled: true, timeoutMs }];
  }
  return [{ id: "custom-searxng", name: "SearXNG", type: "searxng", connectionMode: "custom", enabled: true, timeoutMs, baseUrl }];
}

/** 校验实例数组、唯一 ID 和连接模式组合。 */
function normalizeProviders(value: unknown, managedProviders: ManagedSearchProviderRegistry): SearchProviderConfig[] {
  if (!Array.isArray(value)) throw new TypeError("搜索服务配置必须是数组");
  const providers = value.map((provider) => normalizeProvider(provider, managedProviders));
  const ids = new Set<string>();
  for (const provider of providers) {
    if (ids.has(provider.id)) throw new TypeError("搜索服务标识重复");
    ids.add(provider.id);
  }
  return providers;
}

function normalizeProvider(value: unknown, managedProviders: ManagedSearchProviderRegistry): SearchProviderConfig {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.id)
    || typeof value.name !== "string"
    || !value.name.trim()
    || typeof value.enabled !== "boolean"
    || !["searxng", "bocha", "tavily"].includes(String(value.type))
    || !["managed", "custom", "official"].includes(String(value.connectionMode))) {
    throw new TypeError("搜索服务字段无效");
  }
  const type = value.type as SearchProviderConfig["type"];
  const connectionMode = value.connectionMode as SearchProviderConfig["connectionMode"];
  const validCombination = type === "searxng"
    ? connectionMode === "managed" || connectionMode === "custom"
    : connectionMode === "official";
  if (!validCombination) throw new TypeError("搜索服务连接模式无效");
  if (connectionMode === "managed" && !managedProviders.listTemplates().some((template) => template.id === value.id)) {
    throw new TypeError("受管搜索服务不可用");
  }
  const baseUrl = connectionMode === "custom" ? normalizeBaseUrl(value.baseUrl) : undefined;
  const egressProfileId = value.egressProfileId === undefined ? undefined : normalizeEgressProfileId(value.egressProfileId);
  return {
    id: value.id,
    name: value.name.trim(),
    type,
    connectionMode,
    enabled: value.enabled,
    timeoutMs: readInteger(value.timeoutMs, "搜索服务超时", 1_000, 60_000),
    ...(egressProfileId ? { egressProfileId } : {}),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function normalizeEgressProfileId(value: unknown): string {
  if (value === undefined) return "direct";
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) throw new TypeError("联网出口标识格式无效");
  return value;
}

function readInteger(value: unknown, label: string, minimum: number, maximum: number): number;
function readInteger(value: unknown, label: string, minimum: number, maximum: number, optional: true): number | undefined;
function readInteger(value: unknown, label: string, minimum: number, maximum: number, optional = false): number | undefined {
  if (optional && value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label}必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return value as number;
}

function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("SearXNG 地址必须是字符串");
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("SearXNG 地址格式无效"); }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new TypeError("SearXNG 地址必须是不含凭证的 HTTP 地址");
  }
  return url.toString().replace(/\/$/u, "");
}

function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((domain) => typeof domain !== "string")) throw new TypeError("允许域名必须是字符串数组");
  const domains = [...new Set(value.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (domains.length > 100 || domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(domain))) {
    throw new TypeError("允许域名格式无效");
  }
  return domains;
}

function normalizeContentTypes(value: unknown): Array<"text/html" | "text/plain"> {
  if (!Array.isArray(value) || value.length === 0 || value.some((type) => type !== "text/html" && type !== "text/plain")) {
    throw new TypeError("至少选择一种允许的内容类型");
  }
  return [...new Set(value)] as Array<"text/html" | "text/plain">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
