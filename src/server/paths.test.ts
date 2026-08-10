// @vitest-environment node

import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDataPaths } from "./paths";

describe("配置中心数据路径", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("创建事务、历史和可恢复删除目录并限制为 owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-configuration-paths-"));
    temporaryRoots.push(root);

    const paths = await createDataPaths(root);

    expect(paths.transactionDir).toBe(join(root, "app", "config-transactions"));
    expect(paths.historyDir).toBe(join(root, "app", "config-history"));
    expect(paths.trashDir).toBe(join(root, "app", "trash"));
    expect(paths.databaseFile).toBe(join(root, "app", "bugpaw.sqlite3"));
    expect(paths.instanceLockFile).toBe(join(root, "app", ".bugpaw-instance.lock"));
    expect((await stat(paths.transactionDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.historyDir)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.trashDir)).mode & 0o777).toBe(0o700);
  });

  it("新数据目录不预建默认 Agent 或根工作目录附件", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-configuration-paths-"));
    temporaryRoots.push(root);

    const paths = await createDataPaths(root);

    await expect(stat(join(paths.agentsDir, "default"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.workspaceDir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("创建独立知识库的来源和索引目录并限制为 owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-paths-"));
    temporaryRoots.push(root);

    const paths = await createDataPaths(root);

    expect(paths.knowledgeDir).toBe(join(root, "app", "knowledge"));
    expect((await stat(paths.knowledgeDir)).mode & 0o777).toBe(0o700);
  });
});
