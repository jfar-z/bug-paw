import { BrowserAutomationError } from "./browser-error";

/** 未来浏览器认证状态的隔离范围。 */
export interface BrowserAuthScope {
  /** BugPaw 用户标识。 */
  userId: string;
  /** Agent 标识。 */
  agentId: string;
  /** 精确 Origin。 */
  origin: string;
}

/** 未来可加密持久化的最小浏览器状态。 */
export interface BrowserAuthState {
  /** Playwright storage state 中的 Cookie。 */
  cookies: unknown[];
  /** 按 Origin 隔离的本地存储。 */
  origins?: unknown[];
}

/** 浏览器登录态扩展点；第一期只使用空实现。 */
export interface BrowserAuthStateProvider {
  /** 读取指定隔离范围的状态。 */
  load(input: BrowserAuthScope): Promise<BrowserAuthState | undefined>;
  /** 保存指定隔离范围的状态。 */
  save(input: BrowserAuthScope, state: BrowserAuthState): Promise<void>;
  /** 清理指定隔离范围的状态。 */
  clear(input: BrowserAuthScope): Promise<void>;
}

/** 第一期不读写任何登录态文件的 Provider。 */
export class NoopBrowserAuthStateProvider implements BrowserAuthStateProvider {
  /** 始终返回空状态。 */
  async load(_input: BrowserAuthScope): Promise<undefined> {
    return undefined;
  }

  /** 明确拒绝持久化，防止调用方误以为登录态已经保存。 */
  async save(_input: BrowserAuthScope, _state: BrowserAuthState): Promise<void> {
    throw new BrowserAutomationError(
      "BROWSER_AUTH_STATE_DISABLED",
      "第一期未启用浏览器登录态保存",
      false,
      undefined,
      "当前版本不会保存 Cookie 或 Storage State；请勿依赖跨 Run 登录态。",
    );
  }

  /** 空实现不创建目录或文件。 */
  async clear(_input: BrowserAuthScope): Promise<void> {
    return undefined;
  }
}
