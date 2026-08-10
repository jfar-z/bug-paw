import type { SessionRecord, SessionRepository } from "./session-repository";

/** Session 结构化状态的应用服务，禁止调用方直接猜测 Agent 归属。 */
export class SessionService {
  constructor(private readonly repository: SessionRepository) {}

  async assignAgent(sessionId: string, agentId: string): Promise<void> {
    await this.repository.assign(sessionId, agentId, new Date().toISOString());
  }

  async find(sessionId: string): Promise<SessionRecord | undefined> {
    return this.repository.find(sessionId);
  }

  async getAgentId(sessionId: string): Promise<string | undefined> {
    return (await this.repository.find(sessionId))?.agentId;
  }

  async archive(sessionId: string): Promise<void> {
    await this.repository.archive(sessionId, new Date().toISOString());
  }

  async unarchive(sessionId: string): Promise<void> {
    await this.repository.unarchive(sessionId, new Date().toISOString());
  }

  async rename(sessionId: string, displayName: string): Promise<void> {
    await this.repository.rename(sessionId, displayName, new Date().toISOString());
  }

  async remove(sessionId: string): Promise<void> {
    await this.repository.remove(sessionId);
  }

  async removeByAgent(agentId: string): Promise<void> {
    await this.repository.removeByAgent(agentId);
  }

  async listIdsByAgent(agentId: string): Promise<string[]> {
    return this.repository.listIdsByAgent(agentId);
  }
}
