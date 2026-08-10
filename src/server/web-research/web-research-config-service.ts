import { createVersionedJsonStore } from "../configuration/versioned-json-store";
import {
  DEFAULT_WEB_RESEARCH_CONFIG,
  type WebResearchConfig,
  type WebResearchConfigDocument,
} from "../../shared/web-research-contracts";
import { EgressProfileRegistry } from "./egress-profile-registry";

/**
 * 提供联网搜索配置的版本化读写和输入校验。
 */
export class WebResearchConfigService {
  private readonly store;

  /**
   * @param filePath 联网搜索配置的持久化文件路径
   */
  constructor(filePath: string, private readonly egressProfiles = new EgressProfileRegistry()) {
    this.store = createVersionedJsonStore<WebResearchConfig>(filePath);
  }

  /**
   * 读取当前配置；首次使用时返回未落盘的保守默认值。
   */
  async read(): Promise<WebResearchConfigDocument> {
    const loaded = await this.store.read();
    const config = loaded.value === undefined ? cloneConfig(DEFAULT_WEB_RESEARCH_CONFIG) : normalizeConfig(loaded.value);
    return { revision: loaded.revision, config };
  }

  /**
   * 在 revision 匹配时保存完整配置。
   *
   * @param input 管理员提交的完整配置
   * @param revision 前端读取到的配置版本
   */
  async update(input: WebResearchConfig, revision: string): Promise<WebResearchConfigDocument> {
    const config = normalizeConfig(input);
    await this.egressProfiles.require(config.egressProfileId);
    const written = await this.store.write(config, revision);
    return { revision: written.revision, config };
  }

  /** 将历史 Compose 内网主机名迁移为 BugPaw 统一命名。 */
  async migrateLegacyInternalHost(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const loaded = await this.store.read();
      if (loaded.value === undefined) return;
      const config = normalizeConfig(loaded.value);
      if (config.searxngBaseUrl !== "http://searxng:8080") return;
      try {
        await this.store.write({ ...config, searxngBaseUrl: DEFAULT_WEB_RESEARCH_CONFIG.searxngBaseUrl }, loaded.revision);
        return;
      } catch (error) {
        // 管理员并发保存时只重读一次，避免覆盖其新的外部服务地址。
        if (attempt === 1) throw error;
      }
    }
  }
}

/** 复制数组字段，避免调用方修改共享默认对象。 */
function cloneConfig(config: WebResearchConfig): WebResearchConfig {
  return { ...config, allowedDomains: [...config.allowedDomains], allowedContentTypes: [...config.allowedContentTypes] };
}

/** 校验并归一化管理员保存的配置。 */
function normalizeConfig(value: unknown): WebResearchConfig {
  if (!isRecord(value)) throw new TypeError("联网搜索配置必须是对象");
  const config = value as Partial<WebResearchConfig>;
  if (typeof config.enabled !== "boolean") throw new TypeError("启用状态必须是布尔值");
  if (typeof config.httpsOnly !== "boolean") throw new TypeError("HTTPS 策略必须是布尔值");
  const searxngBaseUrl = normalizeSearxngBaseUrl(config.searxngBaseUrl);
  const allowedDomains = normalizeDomains(config.allowedDomains);
  const allowedContentTypes = normalizeContentTypes(config.allowedContentTypes);
  return {
    enabled: config.enabled,
    searxngBaseUrl,
    // 兼容一期上线前已保存的配置，未指定时保持最保守的直连出口。
    egressProfileId: normalizeEgressProfileId(config.egressProfileId),
    maxResults: readInteger(config.maxResults, "搜索结果数", 1, 20),
    maxTextLength: readInteger(config.maxTextLength, "正文长度", 1_000, 100_000),
    timeoutMs: readInteger(config.timeoutMs, "请求超时", 1_000, 60_000),
    maxRedirects: readInteger(config.maxRedirects, "重定向次数", 0, 10),
    maxResponseBytes: readInteger(config.maxResponseBytes, "响应体大小", 64 * 1024, 10 * 1024 * 1024),
    httpsOnly: config.httpsOnly,
    allowedDomains,
    allowedContentTypes,
  };
}

/** 校验部署侧出口配置档标识，空缺配置降级为默认直连。 */
function normalizeEgressProfileId(value: unknown): string {
  if (value === undefined) return "direct";
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value)) {
    throw new TypeError("联网出口标识格式无效");
  }
  return value;
}

/** 读取整数范围，防止资源限制被无意放宽。 */
function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label}必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return value as number;
}

/** 校验管理员受管的 SearXNG 地址，拒绝 URL 内嵌凭证。 */
function normalizeSearxngBaseUrl(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("SearXNG 地址必须是字符串");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("SearXNG 地址格式无效");
  }
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new TypeError("SearXNG 地址必须是不含凭证的 HTTP 地址");
  }
  return url.toString().replace(/\/$/, "");
}

/** 校验允许名单中的 DNS 名称。 */
function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((domain) => typeof domain !== "string")) throw new TypeError("允许域名必须是字符串数组");
  const domains = [...new Set(value.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (domains.length > 100 || domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain))) {
    throw new TypeError("允许域名格式无效");
  }
  return domains;
}

/** 仅允许一期支持的可提取文本类型。 */
function normalizeContentTypes(value: unknown): Array<"text/html" | "text/plain"> {
  if (!Array.isArray(value) || value.length === 0 || value.some((type) => type !== "text/html" && type !== "text/plain")) {
    throw new TypeError("至少选择一种允许的内容类型");
  }
  return [...new Set(value)] as Array<"text/html" | "text/plain">;
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
