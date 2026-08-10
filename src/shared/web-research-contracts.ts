/**
 * 联网搜索的持久化配置。
 */
export interface WebResearchConfig {
  /** 是否向 Agent Runtime 提供联网工具。 */
  enabled: boolean;
  /** 管理员受管的 SearXNG 服务地址。 */
  searxngBaseUrl: string;
  /** 当前联网请求使用的部署侧出口配置档。 */
  egressProfileId: string;
  /** 单次搜索最多返回的结果数。 */
  maxResults: number;
  /** 单页正文最多保留的字符数。 */
  maxTextLength: number;
  /** 单次出站请求的超时毫秒数。 */
  timeoutMs: number;
  /** 单次网页读取允许的最大重定向次数。 */
  maxRedirects: number;
  /** 单次网页读取允许的最大响应体字节数。 */
  maxResponseBytes: number;
  /** 是否仅允许 Agent 读取 HTTPS 公开网页。 */
  httpsOnly: boolean;
  /** 非空时仅允许这些域名及其子域名。 */
  allowedDomains: string[];
  /** Agent 可读取的公开响应 MIME 类型。 */
  allowedContentTypes: Array<"text/html" | "text/plain">;
}

/**
 * 带乐观锁版本的联网搜索配置文档。
 */
export interface WebResearchConfigDocument {
  /** 配置文件当前版本。 */
  revision: string;
  /** 已通过服务端校验的配置。 */
  config: WebResearchConfig;
}

/** 配置中心读取的联网搜索设置，附带安全出口摘要。 */
export interface WebResearchSettingsDocument extends WebResearchConfigDocument {
  egressProfiles: import("./web-research-egress-contracts").WebResearchEgressProfileSummary[];
}

/** 联网搜索的保守默认策略。 */
export const DEFAULT_WEB_RESEARCH_CONFIG: WebResearchConfig = {
  enabled: false,
  searxngBaseUrl: "http://bug-paw-search:8080",
  egressProfileId: "direct",
  maxResults: 5,
  maxTextLength: 20_000,
  timeoutMs: 10_000,
  maxRedirects: 3,
  maxResponseBytes: 2 * 1024 * 1024,
  httpsOnly: true,
  allowedDomains: [],
  allowedContentTypes: ["text/html", "text/plain"],
};
