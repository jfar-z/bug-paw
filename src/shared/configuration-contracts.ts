/**
 * 配置诊断公开结构。
 */
export interface ConfigurationDiagnostic {
  /**
   * 诊断来源。
   */
  source: "settings" | "models" | "auth" | "resource" | "runtime";
  /**
   * 诊断严重程度。
   */
  severity: "info" | "warning" | "error";
  /**
   * 稳定的机器可读错误码。
   */
  code: string;
  /**
   * 不包含凭证明文的用户可读消息。
   */
  message: string;
  /**
   * 可选字段路径。
   */
  field?: string;
}

/**
 * 具有继承语义的配置文档。
 */
export interface ScopedConfigDocument<T> {
  /**
   * 当前作用域文件版本。
   */
  revision: string;
  /**
   * 当前作用域直接声明的值。
   */
  own: Partial<T>;
  /**
   * 来自全局作用域的值。
   */
  inherited?: Partial<T>;
  /**
   * Pi 最终读取到的合并值。
   */
  effective: T;
  /**
   * Pi 读取与校验诊断。
   */
  diagnostics: ConfigurationDiagnostic[];
}

/**
 * Web 配置中心允许管理的 Pi 设置形状。
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** Pi 支持的统一思考深度。 */
export type ThinkingLevel = typeof THINKING_LEVELS[number];

export interface WebPiSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
  transport?: "sse" | "websocket" | "websocket-cached" | "auto";
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
  branchSummary?: { reserveTokens?: number; skipPrompt?: boolean };
  retry?: {
    enabled?: boolean;
    maxRetries?: number;
    baseDelayMs?: number;
    provider?: { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
  };
  hideThinkingBlock?: boolean;
  thinkingBudgets?: { minimal?: number; low?: number; medium?: number; high?: number };
  images?: { autoResize?: boolean; blockImages?: boolean };
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  httpProxy?: string;
  httpIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  packages?: unknown[];
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
}

/**
 * 模型原生文件公开文档。
 */
export interface ModelConfigDocument {
  /**
   * models.json 当前版本。
   */
  revision: string;
  /**
   * 保留未知 Pi 字段的原始配置。
   */
  value: Record<string, unknown>;
  /**
   * Pi 原生模型校验诊断。
   */
  diagnostics: ConfigurationDiagnostic[];
}

/**
 * 不包含凭证明文的凭证状态。
 */
export interface CredentialStatus {
  providerId: string;
  type: string;
  configured: true;
}

export type ProviderTemplate = "openai-compatible" | "ollama" | "vllm" | "lm-studio" | "custom";

export type ThinkingLevelKey = ThinkingLevel;

/**
 * 配置中心用于普通表单编辑的模型形状。
 */
export interface ProviderEditorModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  thinkingLevelMap: Partial<Record<ThinkingLevelKey, string | null>>;
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: Record<string, unknown>;
}
