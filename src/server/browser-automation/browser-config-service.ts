import {
  DEFAULT_BROWSER_AUTOMATION_CONFIG,
  type BrowserAutomationConfig,
  type BrowserAutomationConfigDocument,
  type BrowserGrantedPermission,
  type TrustedBrowserOrigin,
} from "../../shared/browser-automation-contracts";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";

const ALLOWED_PERMISSIONS = new Set<BrowserGrantedPermission>(["clipboard-read", "clipboard-write"]);
const METADATA_HOSTS = new Set(["169.254.169.254", "fd00:ec2::254"]);

/** 提供浏览器能力非敏感配置的版本化读写和严格规范化。 */
export class BrowserConfigService {
  /** 版本化 JSON 存储。 */
  private readonly store;

  /**
   * 创建浏览器配置服务。
   *
   * @param filePath browser-automation.json 的绝对路径
   */
  constructor(filePath: string) {
    this.store = createVersionedJsonStore<unknown>(filePath);
  }

  /** 读取当前配置；缺失文件只返回默认值，不主动落盘。 */
  async read(): Promise<BrowserAutomationConfigDocument> {
    const loaded = await this.store.read();
    const config = loaded.value === undefined
      ? cloneConfig(DEFAULT_BROWSER_AUTOMATION_CONFIG)
      : normalizeConfig(loaded.value);
    return { revision: loaded.revision, config };
  }

  /** 在 revision 匹配时保存完整配置。 */
  async update(config: BrowserAutomationConfig, revision: string): Promise<BrowserAutomationConfigDocument> {
    const normalized = normalizeConfig(config);
    const written = await this.store.write(normalized, revision);
    return { revision: written.revision, config: normalized };
  }
}

/** 深复制配置，防止调用方修改共享默认对象。 */
function cloneConfig(config: BrowserAutomationConfig): BrowserAutomationConfig {
  return {
    ...config,
    publicBrowsing: { ...config.publicBrowsing, allowedDomains: [...config.publicBrowsing.allowedDomains] },
    trustedOrigins: config.trustedOrigins.map(cloneOrigin),
    localPreview: { ...config.localPreview, grantedPermissions: [...config.localPreview.grantedPermissions] },
    pool: { ...config.pool },
    artifacts: {
      ...config.artifacts,
      allowedDownloadMimeTypes: [...config.artifacts.allowedDownloadMimeTypes],
      screenshotFormats: [...config.artifacts.screenshotFormats],
    },
  };
}

/** 校验整个配置对象并返回规范值。 */
function normalizeConfig(value: unknown): BrowserAutomationConfig {
  if (!isRecord(value) || typeof value.enabled !== "boolean") throw new TypeError("浏览器配置必须是完整对象");
  const publicBrowsing = requireRecord(value.publicBrowsing, "公开浏览配置必须是对象");
  const localPreview = normalizePermissionScope(value.localPreview);
  const pool = requireRecord(value.pool, "资源池配置必须是对象");
  const artifacts = requireRecord(value.artifacts, "浏览产物配置必须是对象");
  if (publicBrowsing.httpsOnly !== true) throw new TypeError("公开浏览必须启用 HTTPS 限制");

  const trustedOrigins = normalizeTrustedOrigins(value.trustedOrigins);
  const maxDownloadBytes = readInteger(artifacts.maxDownloadBytes, "单次下载大小", 1, 100 * 1024 * 1024);
  const maxDownloadBytesPerRun = readInteger(artifacts.maxDownloadBytesPerRun, "单 Run 下载总量", maxDownloadBytes, 1024 * 1024 * 1024);
  return {
    enabled: value.enabled,
    publicBrowsing: {
      httpsOnly: true,
      allowedDomains: normalizeDomains(publicBrowsing.allowedDomains),
      navigationTimeoutMs: readInteger(publicBrowsing.navigationTimeoutMs, "单次导航时间", 10_000, 120_000),
      maxPagesPerContext: readInteger(publicBrowsing.maxPagesPerContext, "单 Context 页面数", 1, 4),
      maxPagesPerRun: readInteger(publicBrowsing.maxPagesPerRun, "单 Run 打开页面数", 1, 100),
    },
    trustedOrigins,
    localPreview,
    pool: {
      maxContexts: readInteger(pool.maxContexts, "全局浏览器上下文数", 1, 4),
      maxContextsPerAgent: readFixedOne(pool.maxContextsPerAgent),
      queueCapacity: readInteger(pool.queueCapacity, "浏览器队列容量", 1, 50),
      queueWaitMs: readInteger(pool.queueWaitMs, "队列等待时间", 60_000, 60 * 60_000),
      heartbeatIntervalMs: readInteger(pool.heartbeatIntervalMs, "浏览器心跳间隔", 10_000, 60_000),
      orphanTimeoutMs: readInteger(pool.orphanTimeoutMs, "浏览器孤儿回收时间", 5 * 60_000, 60 * 60_000),
      runTimeoutMs: readInteger(pool.runTimeoutMs, "浏览器 Run 总时限", 15 * 60_000, 180 * 60_000),
    },
    artifacts: {
      maxScreenshotsPerRun: readInteger(artifacts.maxScreenshotsPerRun, "单 Run 截图数", 1, 50),
      maxDownloadsPerRun: readInteger(artifacts.maxDownloadsPerRun, "单 Run 下载数", 0, 30),
      maxDownloadBytes,
      maxDownloadBytesPerRun,
      downloadTimeoutMs: readInteger(artifacts.downloadTimeoutMs, "单次下载时间", 30_000, 10 * 60_000),
      allowedDownloadMimeTypes: normalizeMimeTypes(artifacts.allowedDownloadMimeTypes),
      screenshotFormats: normalizeScreenshotFormats(artifacts.screenshotFormats),
      maxScreenshotPixels: readInteger(artifacts.maxScreenshotPixels, "截图像素数", 1_000_000, 64_000_000),
    },
    auditRetentionDays: readInteger(value.auditRetentionDays, "审计保留天数", 1, 365),
  };
}

/** 规范化所有受信任 Origin，并拒绝重复项。 */
function normalizeTrustedOrigins(value: unknown): TrustedBrowserOrigin[] {
  if (!Array.isArray(value) || value.length > 100) throw new TypeError("受信任 Origin 列表格式无效");
  const normalized = value.map((item) => {
    const record = requireRecord(item, "受信任 Origin 配置必须是对象");
    if (typeof record.origin !== "string") throw new TypeError("受信任 Origin 必须精确到 Scheme、Host 和 Port");
    return { origin: normalizeOrigin(record.origin), ...normalizePermissionScope(record) };
  });
  const seen = new Set<string>();
  for (const item of normalized) {
    if (seen.has(item.origin)) throw new TypeError("受信任 Origin 不能重复");
    seen.add(item.origin);
  }
  return normalized;
}

/** 规范化不含 Origin 的权限范围。 */
function normalizePermissionScope(value: unknown): Omit<TrustedBrowserOrigin, "origin"> {
  const record = requireRecord(value, "浏览器交互权限必须是对象");
  if (typeof record.allowTextInput !== "boolean"
    || typeof record.allowFormSubmit !== "boolean"
    || typeof record.allowFileUpload !== "boolean"
    || !Array.isArray(record.grantedPermissions)) {
    throw new TypeError("浏览器交互权限字段无效");
  }
  const grantedPermissions = record.grantedPermissions.map((permission) => {
    if (typeof permission !== "string" || !ALLOWED_PERMISSIONS.has(permission as BrowserGrantedPermission)) {
      throw new TypeError("浏览器权限不在允许清单中");
    }
    return permission as BrowserGrantedPermission;
  });
  return {
    allowTextInput: record.allowTextInput,
    allowFormSubmit: record.allowFormSubmit,
    allowFileUpload: record.allowFileUpload,
    grantedPermissions: [...new Set(grantedPermissions)],
  };
}

/** 只接受没有路径、凭证、查询与片段的 HTTP(S) Origin。 */
function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("受信任 Origin 必须精确到 Scheme、Host 和 Port");
  }
  if (!["http:", "https:"].includes(url.protocol)
    || !url.hostname
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
    || value.includes("*")) {
    throw new TypeError("受信任 Origin 必须精确到 Scheme、Host 和 Port");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (METADATA_HOSTS.has(hostname)) throw new TypeError("云元数据地址不能配置为受信任 Origin");
  return url.origin.toLowerCase();
}

/** 规范化公网域名白名单；空数组保留“全部公网 HTTPS”语义。 */
function normalizeDomains(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((domain) => typeof domain !== "string")) throw new TypeError("允许域名必须是字符串数组");
  const domains = [...new Set(value.map((domain) => domain.trim().toLowerCase()).filter(Boolean))];
  if (domains.length > 100 || domains.some((domain) => !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/iu.test(domain))) {
    throw new TypeError("允许域名格式无效");
  }
  return domains;
}

/** 规范化允许下载的 MIME 类型。 */
function normalizeMimeTypes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 || value.some((item) => typeof item !== "string")) {
    throw new TypeError("下载 MIME 类型列表格式无效");
  }
  const values = [...new Set(value.map((item) => item.trim().toLowerCase()))];
  if (values.some((item) => !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(item))) throw new TypeError("下载 MIME 类型格式无效");
  return values;
}

/** 规范化截图格式并保证至少保留一种。 */
function normalizeScreenshotFormats(value: unknown): Array<"png" | "jpeg"> {
  if (!Array.isArray(value) || value.length === 0 || value.some((format) => format !== "png" && format !== "jpeg")) {
    throw new TypeError("截图格式必须是 PNG 或 JPEG");
  }
  return [...new Set(value)] as Array<"png" | "jpeg">;
}

/** 校验第一期固定为一的单 Agent Context 限制。 */
function readFixedOne(value: unknown): 1 {
  if (value !== 1) throw new TypeError("单 Agent 浏览器上下文数固定为 1");
  return 1;
}

/** 读取有界整数。 */
function readInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${label}必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return value as number;
}

/** 读取普通对象，否则抛出指定错误。 */
function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(message);
  return value;
}

/** 判断未知值是否是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深复制单个 Origin 配置。 */
function cloneOrigin(origin: TrustedBrowserOrigin): TrustedBrowserOrigin {
  return { ...origin, grantedPermissions: [...origin.grantedPermissions] };
}
