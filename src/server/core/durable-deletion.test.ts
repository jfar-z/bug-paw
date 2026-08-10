// @vitest-environment node

import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAgentRepository } from "../agents/agent-repository";
import { createTestDatabase } from "../database/test-database";
import { createDataPaths } from "../paths";
import { DurableDeletionCoordinator } from "./durable-deletion";

describe("DurableDeletionCoordinator", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("崩溃恢复时按 SQLite 是否仍存在决定恢复或清理", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-deletion-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const database = createTestDatabase();
    const agents = createAgentRepository(database);
    const profile = { version: 1 as const, id: "a1", name: "A", avatar: { kind: "initial" as const, value: "A" }, description: "", status: "active" as const, cwd: join(paths.workspaceDir, "a1"), allowedTools: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    await agents.insert(profile);
    const target = join(paths.agentsDir, "a1");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "AGENTS.md"), "content", "utf8");
    const coordinator = new DurableDeletionCoordinator(paths.rootDir, paths.deletionTransactionDir, database);

    await coordinator.stage("agent", "a1", [target]);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    await coordinator.recover();
    await expect(access(join(target, "AGENTS.md"))).resolves.toBeUndefined();

    await coordinator.stage("agent", "a1", [target]);
    await agents.remove("a1");
    await coordinator.recover();
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    database.close();
  });

  it("启动时清理 manifest 发布前留下的空 UUID 目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-deletion-orphan-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const database = createTestDatabase();
    const orphan = join(paths.deletionTransactionDir, randomUUID(), "staged");
    await mkdir(orphan, { recursive: true });

    await new DurableDeletionCoordinator(paths.rootDir, paths.deletionTransactionDir, database).recover();

    await expect(access(join(orphan, ".."))).rejects.toMatchObject({ code: "ENOENT" });
    database.close();
  });
});
