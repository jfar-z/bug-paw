// @vitest-environment node

import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentRepository } from "../agents/agent-repository";
import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createDataPaths } from "../paths";
import { createSessionRepository } from "./session-repository";
import { reconcileUnpersistedSessions } from "./session-reconciliation";

describe("reconcileUnpersistedSessions", () => {
  const roots: string[] = [];
  const databases: Database[] = [];

  afterEach(async () => {
    databases.splice(0).forEach((database) => database.close());
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("启动时删除无 JSONL 的首轮崩溃行和检查点，保留已落盘会话", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-session-reconcile-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const database = createTestDatabase();
    databases.push(database);
    const now = "2026-08-07T00:00:00.000Z";
    await createAgentRepository(database).insert({
      version: 1,
      id: "agent-a",
      name: "Agent A",
      avatar: { kind: "initial", value: "A" },
      description: "",
      cwd: join(paths.workspaceDir, "agent-a"),
      status: "active",
      allowedTools: [],
      createdAt: now,
      updatedAt: now,
    });
    const sessions = createSessionRepository(database);
    await sessions.assign("ghost", "agent-a", now);
    await sessions.assign("persisted", "agent-a", now);
    const sessionDirectory = join(paths.piDir, "sessions", "agent-a");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, `${now}_persisted.jsonl`), "{}\n", "utf8");
    await writeFile(join(paths.runDir, "ghost.json"), "{}\n", "utf8");

    await reconcileUnpersistedSessions(paths, database);

    await expect(sessions.find("ghost")).resolves.toBeUndefined();
    await expect(access(join(paths.runDir, "ghost.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(sessions.find("persisted")).resolves.toMatchObject({ id: "persisted" });
  });
});
