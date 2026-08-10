// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CREDENTIAL_HISTORY_SUMMARIES, ConfigHistory, migrateLegacyConfigHistory } from "./config-history";
import { createTestDatabase } from "../database/test-database";
import { createConfigurationHistoryRepository } from "./configuration-history-repository";

describe("ConfigHistory", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("以 owner-only JSON 文件记录非敏感变更摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-config-history-"));
    temporaryRoots.push(root);
    const historyDir = join(root, "history");
    const history = new ConfigHistory(historyDir);

    await history.record({
      id: "history-1",
      createdAt: "2026-08-05T00:00:00.000Z",
      scope: "global",
      summary: "更新 Pi 重试设置",
      outcome: "success",
    });

    const [fileName] = await readdir(historyDir);
    const stored = await readFile(join(historyDir, fileName), "utf8");
    expect(JSON.parse(stored)).toEqual({
      id: "history-1",
      createdAt: "2026-08-05T00:00:00.000Z",
      scope: "global",
      summary: "更新 Pi 重试设置",
      outcome: "success",
    });
    expect((await stat(join(historyDir, fileName))).mode & 0o777).toBe(0o600);
  });

  it("凭证历史只接受固定摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-config-history-"));
    temporaryRoots.push(root);
    const history = new ConfigHistory(join(root, "history"));

    await expect(
      history.record({
        id: "history-2",
        createdAt: "2026-08-05T00:00:00.000Z",
        scope: "credential",
        targetId: "example",
        summary: "保存 test-secret",
        outcome: "success",
      }),
    ).rejects.toThrow("固定摘要");

    await expect(
      history.record({
        id: "history-3",
        createdAt: "2026-08-05T00:00:01.000Z",
        scope: "credential",
        targetId: "example",
        summary: CREDENTIAL_HISTORY_SUMMARIES.updated,
        outcome: "success",
      }),
    ).resolves.toBeUndefined();
  });

  it("生产模式只在 SQLite 保存历史元数据，文件目录仅保存恢复快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-config-history-"));
    temporaryRoots.push(root);
    const historyDir = join(root, "history");
    const database = createTestDatabase();
    const history = new ConfigHistory(historyDir, createConfigurationHistoryRepository(database));

    await history.recordSnapshot({ id: "history-db", scope: "global", revision: "r1", value: { theme: "dark" } });
    await history.record({
      id: "history-db",
      createdAt: "2026-08-05T00:00:00.000Z",
      scope: "global",
      summary: "更新 Pi 设置",
      outcome: "success",
      restorable: true,
    });

    expect(await history.list()).toEqual([expect.objectContaining({ id: "history-db", restorable: true })]);
    expect(await readdir(historyDir)).toEqual(["snapshots"]);
    await expect(history.getSnapshot("history-db")).resolves.toMatchObject({ revision: "r1" });
    database.close();
  });

  it("迁移旧历史时删除操作人字段且不改写快照", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-config-history-"));
    temporaryRoots.push(root);
    const historyDir = join(root, "history");
    const snapshotsDir = join(historyDir, "snapshots");
    const historyFile = join(historyDir, "legacy.json");
    const snapshotFile = join(snapshotsDir, "legacy.json");
    const snapshotBefore = JSON.stringify({ id: "legacy", value: { theme: "dark" } });
    await mkdir(snapshotsDir, { recursive: true });
    await writeFile(historyFile, JSON.stringify({
      id: "history-legacy",
      createdAt: "2026-08-05T00:00:00.000Z",
      username: "legacy-identity",
      scope: "global",
      summary: "更新全局 Pi 设置",
      outcome: "success",
    }), "utf8");
    await writeFile(snapshotFile, snapshotBefore, "utf8");

    await migrateLegacyConfigHistory(historyDir);

    expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual({
      id: "history-legacy",
      createdAt: "2026-08-05T00:00:00.000Z",
      scope: "global",
      summary: "更新全局 Pi 设置",
      outcome: "success",
    });
    expect(await readFile(snapshotFile, "utf8")).toBe(snapshotBefore);
  });
});
