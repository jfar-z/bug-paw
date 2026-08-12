/** 浏览器能力公开的稳定错误码。 */
export type BrowserAutomationErrorCode =
  | "BROWSER_CAPABILITY_DISABLED"
  | "BROWSER_DEPLOYMENT_UNAVAILABLE"
  | "BROWSER_TOOL_NOT_AUTHORIZED"
  | "BROWSER_ORIGIN_NOT_TRUSTED"
  | "BROWSER_TEXT_INPUT_DISABLED"
  | "BROWSER_FORM_SUBMIT_DISABLED"
  | "BROWSER_UPLOAD_DISABLED"
  | "BROWSER_PERMISSION_NOT_GRANTED"
  | "BROWSER_LOCAL_FILE_OUTSIDE_WORKSPACE"
  | "BROWSER_PRIVATE_NETWORK_BLOCKED"
  | "BROWSER_HARD_SAFETY_BLOCKED"
  | "BROWSER_AGENT_QUOTA_REACHED"
  | "BROWSER_QUEUE_FULL"
  | "BROWSER_POOL_WAIT_TIMEOUT"
  | "BROWSER_CONTEXT_EXPIRED"
  | "BROWSER_CONTEXT_NOT_OPEN"
  | "BROWSER_WORKER_UNAVAILABLE"
  | "BROWSER_WORKER_PROTOCOL_INVALID"
  | "BROWSER_NAVIGATION_TIMEOUT"
  | "BROWSER_DOWNLOAD_BLOCKED"
  | "BROWSER_DOWNLOAD_TOO_LARGE"
  | "BROWSER_ARTIFACT_LIMIT_REACHED"
  | "BROWSER_AUTH_STATE_DISABLED"
  | "BROWSER_ELEMENT_REFERENCE_STALE";

/** 策略拒绝对应的管理员配置位置。 */
export interface BrowserPermissionDetail {
  /** 被拒绝的浏览器操作。 */
  operation: string;
  /** 操作目标 Origin。 */
  origin?: string;
  /** 策略作用域。 */
  scope: "global" | "trusted_ui_origin" | "local_preview" | "hard_limit";
  /** 需要调整的设置字段。 */
  requiredSetting?: string;
  /** 配置中心稳定路径。 */
  settingsPath: "/settings/capabilities/browser";
}

/** 浏览器工具返回的结构化错误。 */
export interface BrowserErrorResult {
  status: "error";
  error: {
    code: BrowserAutomationErrorCode;
    message: string;
    retryable: boolean;
    permission?: BrowserPermissionDetail;
    userGuidance?: string;
  };
}

/** 可跨服务稳定映射的浏览器能力错误。 */
export class BrowserAutomationError extends Error {
  /**
   * 创建浏览器能力错误。
   *
   * @param code 稳定错误码
   * @param message 不含内部细节的错误说明
   * @param retryable 同一配置下稍后重试是否可能成功
   * @param permission 可配置权限的定位信息
   * @param userGuidance Agent 可直接转述的处理指引
   */
  constructor(
    readonly code: BrowserAutomationErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly permission?: BrowserPermissionDetail,
    readonly userGuidance?: string,
  ) {
    super(message);
    this.name = "BrowserAutomationError";
  }

  /** 转换为 Pi 工具可返回的安全错误信封。 */
  toResult(): BrowserErrorResult {
    return {
      status: "error",
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.permission ? { permission: this.permission } : {}),
        ...(this.userGuidance ? { userGuidance: this.userGuidance } : {}),
      },
    };
  }
}

interface PolicyErrorInput {
  /** 被拒绝的操作。 */
  operation: string;
  /** 当前页面 Origin。 */
  origin?: string;
  /** 需要开启的配置字段。 */
  requiredSetting?: string;
  /** 本地预览使用独立作用域。 */
  scope?: "global" | "trusted_ui_origin" | "local_preview" | "hard_limit";
}

/** 为常见策略拒绝创建包含配置路径的稳定错误。 */
export function browserPolicyError(code: BrowserAutomationErrorCode, input: PolicyErrorInput): BrowserAutomationError {
  const definition = POLICY_ERRORS[code];
  const scope = input.scope ?? (input.origin ? "trusted_ui_origin" : "global");
  return new BrowserAutomationError(
    code,
    definition?.message ?? "浏览器操作被当前安全策略拒绝",
    false,
    {
      operation: input.operation,
      ...(input.origin ? { origin: input.origin } : {}),
      scope,
      ...(input.requiredSetting ? { requiredSetting: input.requiredSetting } : {}),
      settingsPath: "/settings/capabilities/browser",
    },
    definition?.guidance ?? "请管理员检查“配置中心 → 能力扩展 → 浏览器执行”中的相关策略。",
  );
}

/** 常见可配置拒绝的中文说明。 */
const POLICY_ERRORS: Partial<Record<BrowserAutomationErrorCode, { message: string; guidance: string }>> = {
  BROWSER_TEXT_INPUT_DISABLED: {
    message: "当前 Origin 未启用文本输入能力",
    guidance: "请管理员在“配置中心 → 能力扩展 → 浏览器执行 → 受信任 UI 验证”中添加该 Origin，并开启“允许文本输入”。",
  },
  BROWSER_FORM_SUBMIT_DISABLED: {
    message: "当前 Origin 未启用表单提交能力",
    guidance: "请管理员在“配置中心 → 能力扩展 → 浏览器执行 → 受信任 UI 验证”中开启“允许表单提交”。",
  },
  BROWSER_UPLOAD_DISABLED: {
    message: "当前 Origin 未启用文件上传能力",
    guidance: "请管理员在“配置中心 → 能力扩展 → 浏览器执行 → 受信任 UI 验证”中开启“允许文件上传”。",
  },
  BROWSER_ORIGIN_NOT_TRUSTED: {
    message: "当前 Origin 不在受信任 UI 范围内",
    guidance: "请管理员在“配置中心 → 能力扩展 → 浏览器执行 → 受信任 UI 验证”中添加精确 Origin。",
  },
};
