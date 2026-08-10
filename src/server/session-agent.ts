/**
 * 会话缺少 Agent 归属时的稳定错误。
 */
export class SessionAgentMissingError extends Error {
  readonly code = "SESSION_AGENT_MISSING";

  constructor(sessionId: string) {
    super(`会话 ${sessionId} 未关联 Agent`);
    this.name = "SessionAgentMissingError";
  }
}

interface SessionAgentMetadata {
  getAgentId(sessionId: string): Promise<string | undefined>;
}

/**
 * 读取 Session 的持久化 Agent 归属，不允许根据默认值猜测业务关系。
 *
 * @param sessionId Session 标识
 * @param metadata Session 元数据仓库
 */
export async function resolveSessionAgentId(
  sessionId: string,
  metadata: SessionAgentMetadata | undefined,
): Promise<string> {
  const storedAgentId = await metadata?.getAgentId(sessionId);
  if (storedAgentId) {
    return storedAgentId;
  }

  throw new SessionAgentMissingError(sessionId);
}
