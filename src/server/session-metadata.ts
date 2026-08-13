import type { SessionRepository } from "./sessions/session-repository";

/** Pi Runtime 与 Session Application Service 共用的元数据端口。 */
export interface SessionMetadataStore {
  getAgentId(sessionId: string): Promise<string | undefined>;
  assignAgent(sessionId: string, agentId: string): Promise<void>;
  isArchived(sessionId: string): Promise<boolean>;
  listArchivedIds(): Promise<string[]>;
  listPinnedIds(agentId: string): Promise<string[]>;
  pin(sessionId: string): Promise<void>;
  unpin(sessionId: string): Promise<void>;
  archive(sessionId: string, archivedAt?: string): Promise<void>;
  unarchive(sessionId: string): Promise<void>;
  remove(sessionId: string): Promise<void>;
  listIdsByAgent(agentId: string): Promise<string[]>;
  removeByAgent(agentId: string): Promise<void>;
}

/** 把 SQLite Session Repository 适配为现有 Runtime 端口。 */
export function createSessionMetadataStore(
  repository: SessionRepository,
  now: () => Date = () => new Date(),
): SessionMetadataStore {
  return {
    async getAgentId(sessionId) {
      return (await repository.find(sessionId))?.agentId;
    },
    async assignAgent(sessionId, agentId) {
      await repository.assign(sessionId, agentId, now().toISOString());
    },
    async isArchived(sessionId) {
      return Boolean((await repository.find(sessionId))?.archivedAt);
    },
    listArchivedIds: () => repository.listArchivedIds(),
    listPinnedIds: (agentId) => repository.listPinnedIds(agentId),
    async pin(sessionId) {
      await repository.pin(sessionId, now().toISOString());
    },
    async unpin(sessionId) {
      await repository.unpin(sessionId);
    },
    async archive(sessionId, archivedAt = now().toISOString()) {
      await repository.archive(sessionId, archivedAt);
    },
    async unarchive(sessionId) {
      await repository.unarchive(sessionId, now().toISOString());
    },
    async remove(sessionId) {
      await repository.remove(sessionId);
    },
    listIdsByAgent: (agentId) => repository.listIdsByAgent(agentId),
    removeByAgent: (agentId) => repository.removeByAgent(agentId),
  };
}
