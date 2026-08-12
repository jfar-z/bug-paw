/** 浏览器可预授权的有限权限。 */
export type BrowserGrantedPermission = "clipboard-read" | "clipboard-write";

/** 精确到 Scheme、Host 和 Port 的受信任 UI Origin。 */
export interface TrustedBrowserOrigin {
  /** 规范化后的 Origin。 */
  origin: string;
  /** 是否允许普通文本输入。 */
  allowTextInput: boolean;
  /** 是否允许提交表单。 */
  allowFormSubmit: boolean;
  /** 是否允许上传当前 Agent 工作区文件。 */
  allowFileUpload: boolean;
  /** 允许授予 Browser Context 的有限权限。 */
  grantedPermissions: BrowserGrantedPermission[];
}

/** 浏览器资源池配置。 */
export interface BrowserPoolConfig {
  /** 全局同时活动的 Context 数。 */
  maxContexts: number;
  /** 单 Agent 同时活动的 Context 数；第一期固定为一。 */
  maxContextsPerAgent: 1;
  /** 全局等待队列容量。 */
  queueCapacity: number;
  /** 单次等待资源的最长时间。 */
  queueWaitMs: number;
  /** Runtime 续租心跳间隔。 */
  heartbeatIntervalMs: number;
  /** 心跳消失后回收 Context 的时间。 */
  orphanTimeoutMs: number;
  /** 单个 Run 持有 Context 的总时限。 */
  runTimeoutMs: number;
}

/** 浏览器能力的非敏感持久化配置。 */
export interface BrowserAutomationConfig {
  /** 是否启用浏览器能力。 */
  enabled: boolean;
  /** 公网只读浏览策略。 */
  publicBrowsing: {
    /** 第一阶段固定只允许 HTTPS。 */
    httpsOnly: true;
    /** 空数组表示允许全部公网 HTTPS 域名。 */
    allowedDomains: string[];
    /** 单次导航超时。 */
    navigationTimeoutMs: number;
    /** 单 Context 页面上限。 */
    maxPagesPerContext: number;
    /** 单 Run 打开页面上限。 */
    maxPagesPerRun: number;
  };
  /** 可进行 UI 验证的精确 Origin。 */
  trustedOrigins: TrustedBrowserOrigin[];
  /** 当前 Agent 工作区静态预览的额外交互权限。 */
  localPreview: Omit<TrustedBrowserOrigin, "origin">;
  /** 全局资源池与租约配置。 */
  pool: BrowserPoolConfig;
  /** 截图与下载配额。 */
  artifacts: {
    /** 单 Run 截图上限。 */
    maxScreenshotsPerRun: number;
    /** 单 Run 下载数上限。 */
    maxDownloadsPerRun: number;
    /** 单文件下载字节上限。 */
    maxDownloadBytes: number;
    /** 单 Run 下载总字节上限。 */
    maxDownloadBytesPerRun: number;
    /** 单次下载超时。 */
    downloadTimeoutMs: number;
    /** 允许下载的 MIME 类型。 */
    allowedDownloadMimeTypes: string[];
    /** 允许的截图格式。 */
    screenshotFormats: Array<"png" | "jpeg">;
    /** 截图像素硬门槛内的可配置上限。 */
    maxScreenshotPixels: number;
  };
  /** 最小审计记录保留天数。 */
  auditRetentionDays: number;
}

/** 带乐观锁版本的浏览器配置文档。 */
export interface BrowserAutomationConfigDocument {
  /** 配置文件版本。 */
  revision: string;
  /** 已完成服务端规范化的配置。 */
  config: BrowserAutomationConfig;
}

/** 配置中心展示的浏览器部署状态。 */
export interface BrowserDeploymentStatus {
  /** 当前部署是否包含浏览器组件。 */
  available: boolean;
  /** Worker 是否可连接。 */
  workerAvailable: boolean;
  /** Chromium 是否已经通过健康检查。 */
  chromiumReady: boolean;
  /** 当前活动 Context 数。 */
  activeContexts: number;
  /** 当前排队请求数。 */
  queuedRequests: number;
  /** 最近故障时间。 */
  lastFailureAt?: string;
  /** 最近稳定故障码。 */
  lastFailureCode?: string;
}

/** 配置中心读取的完整设置文档。 */
export interface BrowserAutomationSettingsDocument extends BrowserAutomationConfigDocument {
  /** 非敏感的部署和运行摘要。 */
  deployment: BrowserDeploymentStatus;
}

/** 第一期浏览器能力默认配置。 */
export const DEFAULT_BROWSER_AUTOMATION_CONFIG: BrowserAutomationConfig = {
  enabled: false,
  publicBrowsing: {
    httpsOnly: true,
    allowedDomains: [],
    navigationTimeoutMs: 60_000,
    maxPagesPerContext: 2,
    maxPagesPerRun: 50,
  },
  trustedOrigins: [],
  localPreview: {
    allowTextInput: false,
    allowFormSubmit: false,
    allowFileUpload: false,
    grantedPermissions: [],
  },
  pool: {
    maxContexts: 1,
    maxContextsPerAgent: 1,
    queueCapacity: 10,
    queueWaitMs: 30 * 60_000,
    heartbeatIntervalMs: 30_000,
    orphanTimeoutMs: 15 * 60_000,
    runTimeoutMs: 90 * 60_000,
  },
  artifacts: {
    maxScreenshotsPerRun: 20,
    maxDownloadsPerRun: 10,
    maxDownloadBytes: 50 * 1024 * 1024,
    maxDownloadBytesPerRun: 200 * 1024 * 1024,
    downloadTimeoutMs: 3 * 60_000,
    allowedDownloadMimeTypes: [
      "application/pdf",
      "application/json",
      "application/zip",
      "text/plain",
      "text/csv",
      "image/png",
      "image/jpeg",
      "audio/mpeg",
      "video/mp4",
    ],
    screenshotFormats: ["png", "jpeg"],
    maxScreenshotPixels: 32_000_000,
  },
  auditRetentionDays: 30,
};
