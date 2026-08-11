/** 搜索服务支持的供应商类型。 */
export type SearchProviderType = "searxng" | "bocha" | "tavily";

/** 搜索服务地址的受管方式。 */
export type SearchProviderConnectionMode = "managed" | "custom" | "official";

/** 单个搜索服务实例的非敏感配置。 */
export interface SearchProviderConfig {
  /** 创建后不可修改的实例标识。 */
  id: string;
  /** 配置中心展示的实例名称。 */
  name: string;
  /** 供应商协议类型。 */
  type: SearchProviderType;
  /** 服务地址由部署、管理员或官方 Adapter 管理。 */
  connectionMode: SearchProviderConnectionMode;
  /** 是否参与搜索路由。 */
  enabled: boolean;
  /** 单次供应商请求超时毫秒数。 */
  timeoutMs: number;
  /** 可选的部署侧联网出口标识。 */
  egressProfileId?: string;
  /** 仅自定义 SearXNG 使用的基础地址。 */
  baseUrl?: string;
}

/** 配置中心可添加的搜索服务模板。 */
export interface SearchProviderTemplate {
  id: string;
  name: string;
  type: SearchProviderType;
  connectionMode: SearchProviderConnectionMode;
}

/**
 * 联网搜索的持久化配置。
 */
export interface WebResearchConfig {
  /** 是否向 Agent Runtime 提供联网工具。 */
  enabled: boolean;
  /** 按数组顺序执行故障切换的搜索实例。 */
  searchProviders: SearchProviderConfig[];
  /** 网页正文读取专用的网络与超时设置。 */
  webRead: {
    egressProfileId: string;
    timeoutMs: number;
  };
  /** 单次搜索最多返回的结果数。 */
  maxResults: number;
  /** 单页正文最多保留的字符数。 */
  maxTextLength: number;
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

/** 不含渠道列表的全局联网检索策略。 */
export type WebResearchGlobalConfig = Omit<WebResearchConfig, "searchProviders">;

/** 编辑渠道时对已有凭证执行的明确操作。 */
export type SearchProviderCredentialMutation =
  | { action: "keep" }
  | { action: "replace"; apiKey: string }
  | { action: "remove" };

/** 原子创建搜索渠道与可选凭证的输入。 */
export interface CreateSearchProviderInput {
  /** 非敏感配置文件版本。 */
  configRevision: string;
  /** 凭证文件版本。 */
  credentialRevision: string;
  /** 待创建的渠道配置。 */
  provider: SearchProviderConfig;
  /** 直连供应商使用的 API Key。 */
  apiKey?: string;
}

/** 原子编辑搜索渠道及其凭证的输入。 */
export interface UpdateSearchProviderInput {
  /** 非敏感配置文件版本。 */
  configRevision: string;
  /** 凭证文件版本。 */
  credentialRevision: string;
  /** 编辑后的完整渠道配置。 */
  provider: SearchProviderConfig;
  /** 对渠道凭证执行的操作。 */
  credential: SearchProviderCredentialMutation;
}

/** 调整搜索渠道优先级的输入。 */
export interface ReorderSearchProvidersInput {
  /** 非敏感配置文件版本。 */
  revision: string;
  /** 包含全部现有渠道且不重复的标识顺序。 */
  providerIds: string[];
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
  providerTemplates: SearchProviderTemplate[];
  credentials: import("./configuration-contracts").CredentialStatus[];
  credentialRevision: string;
}

/** 联网搜索的保守默认策略。 */
export const DEFAULT_WEB_RESEARCH_CONFIG: WebResearchConfig = {
  enabled: false,
  searchProviders: [],
  webRead: { egressProfileId: "direct", timeoutMs: 10_000 },
  maxResults: 5,
  maxTextLength: 20_000,
  maxRedirects: 3,
  maxResponseBytes: 2 * 1024 * 1024,
  httpsOnly: true,
  allowedDomains: [],
  allowedContentTypes: ["text/html", "text/plain"],
};
