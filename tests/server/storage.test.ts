// @vitest-environment node

import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDataPaths } from "../../src/server/paths";
import { readJson, writeJsonAtomic } from "../../src/server/storage";

const temporaryRoots: string[] = [];

/**
 * 为单条测试创建隔离的数据根目录。
 */
async function createTemporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-storage-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("持久化路径", () => {
  it("创建 app、Agent 索引、知识库、pi 和 workspace 目录并返回固定文件位置", async () => {
    const root = await createTemporaryRoot();
    const paths = await createDataPaths(root);

    expect(paths).toEqual({
      rootDir: root,
      appDir: join(root, "app"),
      piDir: join(root, "pi"),
      workspaceDir: join(root, "workspace"),
      agentsDir: join(root, "app", "agents"),
      transactionDir: join(root, "app", "config-transactions"),
      deletionTransactionDir: join(root, "app", "deletion-transactions"),
      historyDir: join(root, "app", "config-history"),
      trashDir: join(root, "app", "trash"),
      knowledgeDir: join(root, "app", "knowledge"),
      runDir: join(root, "app", "chat-runs"),
      userAvatarFile: join(root, "app", "user-avatar"),
      databaseFile: join(root, "app", "bugpaw.sqlite3"),
      instanceLockFile: join(root, "app", ".bugpaw-instance.lock"),
    });
    await expect(stat(paths.appDir)).resolves.toMatchObject({});
    await expect(stat(paths.piDir)).resolves.toMatchObject({});
    await expect(stat(paths.workspaceDir)).resolves.toMatchObject({});
    await expect(stat(paths.agentsDir)).resolves.toMatchObject({});
    await expect(stat(paths.runDir)).resolves.toMatchObject({});
    await expect(stat(paths.transactionDir)).resolves.toMatchObject({});
    await expect(stat(paths.deletionTransactionDir)).resolves.toMatchObject({});
    await expect(stat(paths.historyDir)).resolves.toMatchObject({});
    await expect(stat(paths.trashDir)).resolves.toMatchObject({});
    await expect(stat(paths.knowledgeDir)).resolves.toMatchObject({});
    await expect(stat(join(paths.agentsDir, "default"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(paths.workspaceDir, "attachments"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("JSON 安全存储", () => {
  it("通过原子替换写入 JSON 并将最终权限设为 0600", async () => {
    const root = await createTemporaryRoot();
    const target = join(root, "nested", "state.json");

    await writeJsonAtomic(target, { ready: true, count: 2 });

    await expect(readJson(target)).resolves.toEqual({ ready: true, count: 2 });
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readFile(target, "utf8")).toBe('{"ready":true,"count":2}\n');
  });

  it("目标不存在时返回 undefined", async () => {
    const root = await createTemporaryRoot();

    await expect(readJson(join(root, "missing.json"))).resolves.toBeUndefined();
  });

  it("序列化失败时保留原文件内容", async () => {
    const root = await createTemporaryRoot();
    const target = join(root, "state.json");
    await writeJsonAtomic(target, { version: 1 });

    await expect(writeJsonAtomic(target, { invalid: 1n })).rejects.toThrow();

    await expect(readJson(target)).resolves.toEqual({ version: 1 });
  });
});
