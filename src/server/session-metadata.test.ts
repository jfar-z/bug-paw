// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { createAgentRepository, type PersistedAgentProfile } from "./agents/agent-repository";
import type { Database } from "./database/database";
import { createTestDatabase } from "./database/test-database";
import { createSessionMetadataStore } from "./session-metadata";
import { createSessionRepository } from "./sessions/session-repository";

const databases: Database[] = [];

afterEach(() => databases.splice(0).forEach((database) => database.close()));

async function createFixture() {
  const database = createTestDatabase();
  databases.push(database);
  const agents = createAgentRepository(database);
  await agents.insert(profile("agent-a"));
  await agents.insert(profile("agent-b"));
  const sessions = createSessionRepository(database);
  return {
    store: createSessionMetadataStore(sessions, () => new Date("2026-08-05T08:00:00.000Z")),
  };
}

describe("会话归档元数据", () => {
  it("持久化 Session 的 Agent 归属且禁止改绑", async () => {
    const { store } = await createFixture();

    await store.assignAgent("session-1", "agent-a");
    expect(await store.getAgentId("session-1")).toBe("agent-a");
    await expect(store.assignAgent("session-1", "agent-b")).rejects.toThrow("归属");
  });

  it("按 Agent 统计并清理 Session 归属", async () => {
    const { store } = await createFixture();
    await store.assignAgent("session-1", "agent-a");
    await store.assignAgent("session-2", "agent-a");
    await store.assignAgent("session-3", "agent-b");

    expect(await store.listIdsByAgent("agent-a")).toEqual(["session-1", "session-2"]);
    await store.removeByAgent("agent-a");
    expect(await store.listIdsByAgent("agent-a")).toEqual([]);
    expect(await store.getAgentId("session-3")).toBe("agent-b");
  });

  it("归档、恢复和移除操作保持幂等", async () => {
    const { store } = await createFixture();
    await store.assignAgent("session-1", "agent-a");

    await store.archive("session-1", "2026-08-05T08:00:00.000Z");
    await store.archive("session-1", "2026-08-05T09:00:00.000Z");
    expect(await store.isArchived("session-1")).toBe(true);
    expect(await store.listArchivedIds()).toEqual(["session-1"]);

    await store.unarchive("session-1");
    await store.unarchive("session-1");
    expect(await store.isArchived("session-1")).toBe(false);

    await store.archive("session-1");
    await store.remove("session-1");
    await store.remove("session-1");
    expect(await store.listArchivedIds()).toEqual([]);
  });

  it("拒绝非法会话标识", async () => {
    const { store } = await createFixture();

    await expect(store.archive("../session")).rejects.toThrow("Session ID");
  });
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
    createdAt: "2026-08-05T08:00:00.000Z",
    updatedAt: "2026-08-05T08:00:00.000Z",
  };
}
