/** Worker 判定交互风险所需的最小元素语义。 */
export interface BrowserElementDescriptor {
  /** 小写 HTML 标签。 */
  tagName: string;
  /** input/button 类型。 */
  type: string;
  /** autocomplete 提示。 */
  autocomplete: string;
  /** 可访问角色。 */
  role: string;
  /** 可访问名称。 */
  accessibleName: string;
}

/** Worker 原子动作的稳定安全错误。 */
export class BrowserActionSafetyError extends Error {
  /** 创建动作安全错误。 */
  constructor(readonly code: "BROWSER_HARD_SAFETY_BLOCKED" | "BROWSER_FORM_SUBMIT_DISABLED", message: string) {
    super(message);
    this.name = "BrowserActionSafetyError";
  }
}

const FORBIDDEN_AUTOCOMPLETE = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
]);
const SENSITIVE_NAME = /(?:密码|口令|验证码|动态码|恢复码|安全码|银行卡|卡号|支付|转账|api[ _-]?key|access[ _-]?token|secret|password|mfa|otp|recovery)/iu;
const IRREVERSIBLE_NAME = /(?:立即支付|确认支付|转账|下单|购买|删除账号|注销账号|修改密码|安全设置|pay now|purchase|delete account)/iu;

/** 拒绝密码、MFA、密钥、支付和账号安全字段。 */
export function assertSafeTextInput(element: BrowserElementDescriptor): void {
  const autocomplete = element.autocomplete.trim().toLowerCase().split(/\s+/u);
  if (element.type.toLowerCase() === "password"
    || autocomplete.some((value) => FORBIDDEN_AUTOCOMPLETE.has(value))
    || SENSITIVE_NAME.test(element.accessibleName)) {
    throw new BrowserActionSafetyError("BROWSER_HARD_SAFETY_BLOCKED", "系统禁止向密码、认证、密钥或支付字段输入内容");
  }
}

/** 识别需要 browser_submit 或属于硬禁区的动作。 */
export function isSubmitLike(element: BrowserElementDescriptor): boolean {
  const type = element.type.toLowerCase();
  return type === "submit" || IRREVERSIBLE_NAME.test(element.accessibleName);
}

/** 在 click 工具中拒绝隐式提交。 */
export function assertSafeClick(element: BrowserElementDescriptor): void {
  if (IRREVERSIBLE_NAME.test(element.accessibleName)) {
    throw new BrowserActionSafetyError("BROWSER_HARD_SAFETY_BLOCKED", "系统禁止支付、账号删除或安全设置操作");
  }
  if (element.type.toLowerCase() === "submit") {
    throw new BrowserActionSafetyError("BROWSER_FORM_SUBMIT_DISABLED", "提交型元素必须使用 browser_submit");
  }
}

/** 在 submit 工具中仍拒绝不可逆硬禁区。 */
export function assertSafeSubmit(element: BrowserElementDescriptor): void {
  if (IRREVERSIBLE_NAME.test(element.accessibleName)) {
    throw new BrowserActionSafetyError("BROWSER_HARD_SAFETY_BLOCKED", "系统禁止支付、账号删除或安全设置操作");
  }
}
