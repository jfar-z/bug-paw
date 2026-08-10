// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { createAgentRepository, type PersistedAgentProfile } from "../agents/agent-repository";
import { createTestDatabase } from "../database/test-database";
import type { Database } from "../database/database";
import { createSessionRepository } from "./session-repository";

describe("SessionRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("禁止把 Session 改绑给其他 Agent", async () => {
    const { agents, sessions } = createRepositories();
    await agents.insert(profile("a1"));
    await agents.insert(profile("a2"));
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");

    await expect(sessions.assign("s1", "a2", "2026-08-07T01:00:00.000Z")).rejects.toMatchObject({
      code: "SESSION_AGENT_CONFLICT",
    });
    expect(await sessions.find("s1")).toMatchObject({ agentId: "a1" });
  });

  it("归档和 Projection 版本更新持久化在同一 Session 记录", async () => {
    const { agents, sessions } = createRepositories();
    await agents.insert(profile("a1"));
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");

    await sessions.archive("s1", "2026-08-07T02:00:00.000Z");
    const version = await sessions.bumpProjectionVersion("s1", "2026-08-07T03:00:00.000Z");

    expect(version).toBe(1);
    expect(await sessions.find("s1")).toMatchObject({
      agentId: "a1",
      archivedAt: "2026-08-07T02:00:00.000Z",
      projectionVersion: 1,
    });
  });

  it("删除 Session 与其绑定定时任务在同一事务完成", async () => {
    const { database, agents, sessions } = createRepositories();
    await agents.insert(profile("a1"));
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");
    database.write(
      "INSERT INTO scheduled_tasks(id, agent_id, session_id, task_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["t1", "a1", "s1", JSON.stringify({ target: { type: "existing_session", sessionId: "s1" } }), "2026-08-07T00:00:00.000Z", "2026-08-07T00:00:00.000Z"],
    );

    await expect(sessions.removeWithBoundTasks("s1", false)).rejects.toMatchObject({ code: "SCHEDULED_TASKS_BOUND" });
    expect(await sessions.find("s1")).toBeDefined();
    await sessions.removeWithBoundTasks("s1", true);

    expect(await sessions.find("s1")).toBeUndefined();
    expect(database.read("SELECT id FROM scheduled_tasks WHERE id = ?", ["t1"])).toEqual([]);
  });

  function createRepositories() {
    const database = createTestDatabase();
    databases.push(database);
    return {
      database,
      agents: createAgentRepository(database),
      sessions: createSessionRepository(database),
    };
  }
});

function profile(id: string): PersistedAgentProfile {
  return {
    version: 1,
    id,
    name: id,
    avatar: { kind: "initial", value: "A" },
    description: "",
    status: "active",
    cwd: `/data/workspace/agents/${id}`,
    allowedTools: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
