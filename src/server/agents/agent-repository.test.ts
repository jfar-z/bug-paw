// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../database/test-database";
import type { Database } from "../database/database";
import { createAgentRepository, type PersistedAgentProfile } from "./agent-repository";
import { createSessionRepository } from "../sessions/session-repository";

describe("AgentRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("两个调用方使用同一 Revision 时只有一个更新成功", async () => {
    const repository = createRepository();
    const current = await repository.insert(profile("a1", "初始名称"));

    const results = await Promise.allSettled([
      repository.update("a1", current.revision, { ...current.profile, name: "名称 A" }),
      repository.update("a1", current.revision, { ...current.profile, name: "名称 B" }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await repository.findById("a1"))?.revision).toBe("2");
  });

  it("按持久化顺序返回 Agent 并以事务重排", async () => {
    const repository = createRepository();
    await repository.insert(profile("a1", "一"));
    await repository.insert(profile("a2", "二"));

    await repository.reorder(["a2", "a1"]);

    expect((await repository.list()).map(({ profile }) => profile.id)).toEqual(["a2", "a1"]);
  });

  it("有关联 Session 时要求明确删除，并在确认后原子删除元数据", async () => {
    const database = createTestDatabase();
    databases.push(database);
    const repository = createAgentRepository(database);
    const sessions = createSessionRepository(database);
    await repository.insert(profile("a1", "一"));
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");

    await expect(repository.remove("a1", false)).rejects.toMatchObject({ code: "AGENT_HAS_SESSIONS" });
    await expect(repository.findById("a1")).resolves.toBeDefined();
    await expect(sessions.find("s1")).resolves.toBeDefined();

    await repository.remove("a1", true);

    await expect(repository.findById("a1")).resolves.toBeUndefined();
    await expect(sessions.find("s1")).resolves.toBeUndefined();
  });

  it("数据库原子拒绝并发的相同或嵌套工作目录", async () => {
    const repository = createRepository();
    const first = profile("a1", "一");
    await repository.insert(first);

    await expect(repository.insert({ ...profile("a2", "二"), cwd: `${first.cwd}/child` }))
      .rejects.toMatchObject({ code: "WORKSPACE_IN_USE" });
    await expect(repository.insert({ ...profile("a3", "三"), cwd: "/data/workspace/agents" }))
      .rejects.toMatchObject({ code: "WORKSPACE_IN_USE" });
  });

  function createRepository() {
    const database = createTestDatabase();
    databases.push(database);
    return createAgentRepository(database);
  }
});

function profile(id: string, name: string): PersistedAgentProfile {
  return {
    version: 1,
    id,
    name,
    avatar: { kind: "initial", value: name.slice(0, 1) },
    description: "",
    status: "active",
    cwd: `/data/workspace/agents/${id}`,
    allowedTools: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
