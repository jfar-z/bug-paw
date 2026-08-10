// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../storage";

import { ConfigTransaction } from "./config-transaction";
import { createVersionedJsonStore } from "./versioned-json-store";

describe("ConfigTransaction", () => {
  const temporaryRoots: string[] = [];

  async function createFixture() {
    const rootDir = await mkdtemp(join(tmpdir(), "pi-config-transaction-"));
    temporaryRoots.push(rootDir);
    return {
      rootDir,
      transactionDir: join(rootDir, "app", "config-transactions"),
      firstPath: join(rootDir, "pi", "settings.json"),
      secondPath: join(rootDir, "pi", "auth.json"),
    };
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("第二个文件替换失败时立即恢复全部文件的事务前版本", async () => {
    const fixture = await createFixture();
    const firstStore = createVersionedJsonStore<{ value: number }>(fixture.firstPath);
    const secondStore = createVersionedJsonStore<{ key: string }>(fixture.secondPath);
    const first = await firstStore.write({ value: 1 });
    const second = await secondStore.write({ key: "test-key" });
    let replacementCount = 0;
    const transaction = new ConfigTransaction({
      rootDir: fixture.rootDir,
      transactionDir: fixture.transactionDir,
      replaceFile: async (path, content) => {
        replacementCount += 1;
        if (replacementCount === 2) {
          throw new Error("injected replacement failure");
        }
        await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
      },
    });

    await expect(
      transaction.run([
        {
          path: fixture.firstPath,
          expectedRevision: first.revision,
          nextContent: '{"value":2}\n',
          sensitive: false,
        },
        {
          path: fixture.secondPath,
          expectedRevision: second.revision,
          nextContent: '{"key":"replacement-key"}\n',
          sensitive: true,
        },
      ]),
    ).rejects.toMatchObject({ code: "CONFIG_COMMIT_FAILED" });

    expect(await readFile(fixture.firstPath, "utf8")).toBe('{"value":1}\n');
    expect(await readFile(fixture.secondPath, "utf8")).toBe('{"key":"test-key"}\n');
    expect((await stat(fixture.secondPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(fixture.transactionDir)).toEqual([]);
  });

  it("成功后清理敏感文件的恢复副本", async () => {
    const fixture = await createFixture();
    const store = createVersionedJsonStore<{ key: string }>(fixture.secondPath);
    const initial = await store.write({ key: "test-key" });
    const transaction = new ConfigTransaction(fixture);

    await transaction.run([
      {
        path: fixture.secondPath,
        expectedRevision: initial.revision,
        nextContent: '{"key":"replacement-key"}\n',
        sensitive: true,
      },
    ]);

    expect(await readdir(fixture.transactionDir)).toEqual([]);
    expect(await readFile(fixture.secondPath, "utf8")).toBe('{"key":"replacement-key"}\n');
  });

  it("重启恢复遇到 durable commit marker 时只清理事务垃圾而不回滚", async () => {
    const fixture = await createFixture();
    const workingDir = join(fixture.transactionDir, "committed-transaction");
    await mkdir(join(workingDir, "backups"), { recursive: true });
    await mkdir(join(fixture.rootDir, "pi"), { recursive: true });
    await writeFile(fixture.firstPath, '{"value":2}\n', "utf8");
    await writeFile(join(workingDir, "backups", "0.bin"), '{"value":1}\n', "utf8");
    await writeFile(join(workingDir, "manifest.json"), JSON.stringify({
      version: 1,
      id: "committed-transaction",
      createdAt: "2026-08-07T00:00:00.000Z",
      entries: [{ path: fixture.firstPath, existed: true, backupFile: "backups/0.bin", sensitive: false }],
    }), "utf8");
    await writeFile(join(workingDir, "committed.json"), '{"version":1}\n', "utf8");

    await new ConfigTransaction(fixture).recover();

    expect(await readFile(fixture.firstPath, "utf8")).toBe('{"value":2}\n');
    expect(await readdir(fixture.transactionDir)).toEqual([]);
  });

  it("提交标记写入失败时先回滚再允许后续写入与恢复", async () => {
    const fixture = await createFixture();
    const store = createVersionedJsonStore<{ value: number }>(fixture.firstPath);
    const initial = await store.write({ value: 1 });
    const writeMetadata = vi.fn(async (path: string, value: unknown) => {
      if (path.endsWith("committed.json")) throw new Error("marker fsync failed");
      await writeJsonAtomic(path, value);
    });
    const failing = new ConfigTransaction({ ...fixture, writeMetadata });

    await expect(failing.execute([{
      path: fixture.firstPath,
      expectedRevision: initial.revision,
      nextContent: '{"value":2}\n',
      sensitive: false,
    }])).rejects.toMatchObject({ code: "CONFIG_COMMIT_FAILED" });
    expect(await readFile(fixture.firstPath, "utf8")).toBe('{"value":1}\n');

    const current = await store.read();
    await store.write({ value: 3 }, current.revision);
    await new ConfigTransaction(fixture).recover();

    expect(JSON.parse(await readFile(fixture.firstPath, "utf8"))).toEqual({ value: 3 });
    expect(await readdir(fixture.transactionDir)).toEqual([]);
  });

  it("重启时清理没有 manifest 的 UUID 孤儿备份目录", async () => {
    const fixture = await createFixture();
    const workingDir = join(fixture.transactionDir, randomUUID());
    await mkdir(join(workingDir, "backups"), { recursive: true });
    await writeFile(join(workingDir, "backups", "auth.bin"), "sensitive credential", "utf8");

    await new ConfigTransaction(fixture).recover();

    expect(await readdir(fixture.transactionDir)).toEqual([]);
  });

  it("提交前拒绝数据根目录之外的目标", async () => {
    const fixture = await createFixture();
    const transaction = new ConfigTransaction(fixture);
    const outsidePath = join(fixture.rootDir, "..", "outside.json");

    await expect(
      transaction.run([
        {
          path: outsidePath,
          expectedRevision: "missing",
          nextContent: "{}\n",
          sensitive: false,
        },
      ]),
    ).rejects.toThrow("数据根目录");
  });

  it("拒绝通过数据根目录内的符号链接写到外部", async () => {
    const fixture = await createFixture();
    const outsideDir = await mkdtemp(join(tmpdir(), "pi-config-transaction-outside-"));
    temporaryRoots.push(outsideDir);
    const linkedDir = join(fixture.rootDir, "linked-pi");
    await symlink(outsideDir, linkedDir, "dir");
    const linkedTarget = join(linkedDir, "settings.json");
    const revision = (await createVersionedJsonStore(linkedTarget).read()).revision;
    const transaction = new ConfigTransaction(fixture);

    await expect(
      transaction.run([
        {
          path: linkedTarget,
          expectedRevision: revision,
          nextContent: "{}\n",
          sensitive: false,
        },
      ]),
    ).rejects.toThrow("数据根目录");

    await expect(stat(join(outsideDir, "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("版本预检失败时一个文件也不修改", async () => {
    const fixture = await createFixture();
    const firstStore = createVersionedJsonStore<{ value: number }>(fixture.firstPath);
    const first = await firstStore.write({ value: 1 });
    const transaction = new ConfigTransaction(fixture);

    await expect(
      transaction.run([
        {
          path: fixture.firstPath,
          expectedRevision: first.revision,
          nextContent: '{"value":2}\n',
          sensitive: false,
        },
        {
          path: fixture.secondPath,
          expectedRevision: "stale-revision",
          nextContent: "{}\n",
          sensitive: false,
        },
      ]),
    ).rejects.toMatchObject({ name: "VersionConflictError" });

    expect(await readFile(fixture.firstPath, "utf8")).toBe('{"value":1}\n');
  });
});
