// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentRepository, type PersistedAgentProfile } from "../../src/server/agents/agent-repository";
import { openDatabase } from "../../src/server/database/database";
import { runMigrations } from "../../src/server/database/migrator";
import { createSessionRepository } from "../../src/server/sessions/session-repository";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SQLite 重启恢复集成", () => {
  it("关闭并重新打开数据库后保持 Agent、Session 归属和 Projection 版本", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-restart-"));
    roots.push(root);
    const databasePath = join(root, "bugpaw.sqlite3");
    const first = openDatabase(databasePath);
    runMigrations(first);
    const agents = createAgentRepository(first);
    const sessions = createSessionRepository(first);
    await agents.insert(agentProfile(root));
    await sessions.assign("session-restart", "agent-restart", "2026-08-07T00:00:00.000Z");
    await sessions.bumpProjectionVersion("session-restart", "2026-08-07T00:01:00.000Z");
    first.checkpoint();
    first.close();

    const restarted = openDatabase(databasePath);
    runMigrations(restarted);
    const recoveredAgent = await createAgentRepository(restarted).findById("agent-restart");
    const recoveredSession = await createSessionRepository(restarted).find("session-restart");

    expect(recoveredAgent).toMatchObject({ profile: { id: "agent-restart", name: "恢复 Agent" }, revision: "1" });
    expect(recoveredSession).toMatchObject({
      id: "session-restart",
      agentId: "agent-restart",
      projectionVersion: 1,
    });
    restarted.close();
  });
});

function agentProfile(root: string): PersistedAgentProfile {
  return {
    version: 1,
    id: "agent-restart",
    name: "恢复 Agent",
    avatar: { kind: "initial", value: "恢" },
    description: "",
    status: "active",
    cwd: join(root, "workspace"),
    allowedTools: [],
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  };
}
