/** 联网能力可以公开返回的稳定错误代码。 */
export type WebResearchErrorCode = "WEB_EGRESS_PROFILE_UNAVAILABLE" | "WEB_FETCH_FAILED";

/** 向 Agent 返回不含部署网络细节的联网错误。 */
export class WebResearchError extends Error {
  /** 稳定错误代码，供 Agent 选择后续处理方式。 */
  readonly code: WebResearchErrorCode;

  /** 供 Agent 继续处理的安全建议。 */
  readonly suggestion: string;

  constructor(code: WebResearchErrorCode) {
    super(code === "WEB_EGRESS_PROFILE_UNAVAILABLE" ? "所选联网出口配置不可用" : "无法读取该公开网页，请稍后重试");
    this.name = "WebResearchError";
    this.code = code;
    this.suggestion = code === "WEB_EGRESS_PROFILE_UNAVAILABLE" ? "请在配置中心选择已部署的联网出口，或联系管理员检查部署配置。" : "请稍后重试，或更换其他公开来源。";
  }
}
