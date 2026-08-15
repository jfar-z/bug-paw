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

  it("幂等置顶和取消置顶且不改变业务更新时间", async () => {
    const { agents, sessions } = createRepositories();
    await agents.insert(profile("a1"));
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");

    await sessions.pin("s1", "2026-08-07T01:00:00.000Z");
    await sessions.pin("s1", "2026-08-07T02:00:00.000Z");

    expect(await sessions.find("s1")).toMatchObject({
      pinnedAt: "2026-08-07T01:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    expect(await sessions.listPinnedIds("a1")).toEqual(["s1"]);

    await sessions.unpin("s1");
    await sessions.unpin("s1");
    expect(await sessions.find("s1")).not.toHaveProperty("pinnedAt");
  });

  it("归档时清除置顶并拒绝重新置顶", async () => {
    const { agents, sessions } = createRepositories();
    await agents.insert(profile("a1"));
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");
    await sessions.pin("s1", "2026-08-07T01:00:00.000Z");

    await sessions.archive("s1", "2026-08-07T02:00:00.000Z");

    expect(await sessions.find("s1")).not.toHaveProperty("pinnedAt");
    await expect(sessions.pin("s1", "2026-08-07T03:00:00.000Z"))
      .rejects.toMatchObject({ code: "SESSION_ARCHIVED" });
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
