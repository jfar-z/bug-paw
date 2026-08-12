import { BrowserAutomationError } from "./browser-error";

/** Runtime 提供的可信浏览器 Run 身份。 */
export interface BrowserRunIdentity {
  /** Agent 标识。 */
  agentId: string;
  /** 会话标识。 */
  sessionId: string;
  /** 单次 Prompt Run 标识。 */
  runId: string;
  /** 当前 Agent 工作目录。 */
  cwd: string;
}

/** 保存 Session 到当前活动 Run 的进程内映射。 */
export class BrowserRunRegistry {
  /** 以 Session 为键的活动 Run。 */
  private readonly runs = new Map<string, BrowserRunIdentity>();

  /** 在 Runtime 启动 Run 时登记可信身份。 */
  begin(identity: BrowserRunIdentity): void {
    if (this.runs.has(identity.sessionId)) throw new Error("会话已经绑定活动的浏览器 Run");
    this.runs.set(identity.sessionId, { ...identity });
  }

  /** 读取当前 Session 的活动 Run，禁止模型通过参数伪造身份。 */
  requireCurrent(sessionId: string): BrowserRunIdentity {
    const identity = this.runs.get(sessionId);
    if (!identity) {
      throw new BrowserAutomationError("BROWSER_CONTEXT_NOT_OPEN", "当前会话没有活动的浏览器 Run", false);
    }
    return { ...identity };
  }

  /** 仅当 Run ID 匹配时结束映射，避免旧回调删除新 Run。 */
  end(sessionId: string, runId: string): boolean {
    if (this.runs.get(sessionId)?.runId !== runId) return false;
    return this.runs.delete(sessionId);
  }
}
