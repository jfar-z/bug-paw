import type { AgentProfile } from "../../shared/agent-contracts";
import { DomainError } from "../core/errors";
import type { Database } from "../database/database";

export type PersistedAgentProfile = Omit<AgentProfile, "instructions">;

export interface PersistedAgentDocument {
  profile: PersistedAgentProfile;
  revision: string;
}

export interface AgentRepository {
  list(): Promise<PersistedAgentDocument[]>;
  findById(id: string): Promise<PersistedAgentDocument | undefined>;
  insert(profile: PersistedAgentProfile): Promise<PersistedAgentDocument>;
  update(id: string, expectedRevision: string, profile: PersistedAgentProfile): Promise<PersistedAgentDocument>;
  reorder(ids: string[]): Promise<void>;
  remove(id: string, removeSessions?: boolean): Promise<void>;
}

/** 创建以 SQLite Revision 提供乐观并发控制的 Agent Repository。 */
export function createAgentRepository(database: Database): AgentRepository {
  return {
    async list() {
      return database.read<AgentRow>("SELECT * FROM agents ORDER BY sort_order, id").map(toDocument);
    },
    async findById(id) {
      const row = database.readOne<AgentRow>("SELECT * FROM agents WHERE id = ?", [id]);
      return row ? toDocument(row) : undefined;
    },
    async insert(profile) {
      try {
        return database.transaction(() => {
        const order = database.readOne<{ next_order: number }>(
          "SELECT COALESCE(MAX(sort_order) + 1, 0) AS next_order FROM agents",
        )?.next_order ?? 0;
        database.write(`
          INSERT INTO agents(id, cwd, profile_json, sort_order, revision, archived_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        `, [
          profile.id,
          profile.cwd,
          JSON.stringify(profile),
          order,
          profile.status === "archived" ? profile.updatedAt : null,
          profile.createdAt,
          profile.updatedAt,
        ]);
          return { profile, revision: "1" };
        });
      } catch (error) {
        throwWorkspaceConflict(error);
      }
    },
    async update(id, expectedRevision, profile) {
      const revision = parseRevision(expectedRevision);
      if (profile.id !== id) throw new DomainError("VALIDATION_FAILED", "Agent ID 与更新目标不一致");
      let result;
      try {
        result = database.write(`
          UPDATE agents
          SET cwd = ?, profile_json = ?, revision = revision + 1, archived_at = ?, updated_at = ?
          WHERE id = ? AND revision = ?
        `, [
          profile.cwd,
          JSON.stringify(profile),
          profile.status === "archived" ? profile.updatedAt : null,
          profile.updatedAt,
          id,
          revision,
        ]);
      } catch (error) {
        throwWorkspaceConflict(error);
      }
      if (result.changes !== 1) {
        throw new DomainError("VERSION_CONFLICT", "Agent 已被其他请求修改");
      }
      return { profile, revision: String(revision + 1) };
    },
    async reorder(ids) {
      database.transaction(() => {
        const rows = database.read<{ id: string }>("SELECT id FROM agents ORDER BY sort_order, id");
        const known = new Set(rows.map(({ id }) => id));
        if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !known.has(id))) {
          throw new DomainError("VALIDATION_FAILED", "Agent 排序包含未知或重复 ID");
        }
        // 先移入负数区间，避免唯一索引在交换顺序的中间状态冲突。
        database.write("UPDATE agents SET sort_order = -sort_order - 1");
        ids.forEach((id, index) => {
          database.write("UPDATE agents SET sort_order = ? WHERE id = ?", [index, id]);
        });
      });
    },
    async remove(id, removeSessions = false) {
      database.transaction(() => {
        const sessionCount = database.readOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM sessions WHERE agent_id = ?",
          [id],
        )?.count ?? 0;
        if (sessionCount > 0 && !removeSessions) {
          throw new DomainError("AGENT_HAS_SESSIONS", "Agent 仍有关联 Session，请确认同时删除后重试", { sessionCount });
        }
        if (removeSessions) database.write("DELETE FROM sessions WHERE agent_id = ?", [id]);
        database.write("DELETE FROM agents WHERE id = ?", [id]);
      });
    },
  };
}

interface AgentRow extends Record<string, unknown> {
  id: string;
  profile_json: string;
  revision: number;
}

function toDocument(row: AgentRow): PersistedAgentDocument {
  const value: unknown = JSON.parse(row.profile_json);
  if (!isPersistedAgentProfile(value) || value.id !== row.id) {
    throw new DomainError("INTERNAL_ERROR", "Agent 持久化数据无效");
  }
  return { profile: value, revision: String(row.revision) };
}

function isPersistedAgentProfile(value: unknown): value is PersistedAgentProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const profile = value as Partial<PersistedAgentProfile>;
  return profile.version === 1
    && typeof profile.id === "string"
    && typeof profile.name === "string"
    && typeof profile.cwd === "string"
    && (profile.status === "active" || profile.status === "archived")
    && Array.isArray(profile.allowedTools)
    && profile.allowedTools.every((tool) => typeof tool === "string")
    && typeof profile.createdAt === "string"
    && typeof profile.updatedAt === "string";
}

function parseRevision(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw new DomainError("VALIDATION_FAILED", "Agent Revision 无效");
  return Number(value);
}

function throwWorkspaceConflict(error: unknown): never {
  if (error instanceof Error && /agent workspace overlaps|UNIQUE constraint failed: agents\.cwd/u.test(error.message)) {
    throw new DomainError("WORKSPACE_IN_USE", "工作目录与其他 Agent 重叠", undefined, { cause: error });
  }
  throw error;
}
