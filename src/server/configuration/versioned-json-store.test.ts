import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createVersionedJsonStore } from "./versioned-json-store";

describe("VersionedJsonStore", () => {
  const temporaryDirectories: string[] = [];

  async function createFilePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "pi-versioned-store-"));
    temporaryDirectories.push(directory);
    return join(directory, "settings.json");
  }

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        const { rm } = await import("node:fs/promises");
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it("缺失文件返回稳定的不存在版本", async () => {
    const filePath = await createFilePath();
    const store = createVersionedJsonStore<{ value: number }>(filePath);

    const first = await store.read();
    const second = await store.read();

    expect(first).toEqual({ exists: false, revision: second.revision });
    expect(first.revision).not.toBe("");
  });

  it("写入 JSON 时使用原始 UTF-8 内容计算稳定版本并保持 0600 权限", async () => {
    const filePath = await createFilePath();
    const store = createVersionedJsonStore<{ label: string }>(filePath);

    const written = await store.write({ label: "配置中心" });
    await chmod(filePath, 0o644);
    const rewritten = await store.write({ label: "配置中心" }, written.revision);
    const loaded = await store.read();

    expect(await readFile(filePath, "utf8")).toBe('{"label":"配置中心"}\n');
    expect(rewritten).toEqual(loaded);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("拒绝使用过期版本覆盖外部修改", async () => {
    const filePath = await createFilePath();
    const store = createVersionedJsonStore<{ value: number }>(filePath);
    await store.write({ value: 1 });
    const loaded = await store.read();
    await writeFile(filePath, '{"value":2}\n', "utf8");

    await expect(store.write({ value: 3 }, loaded.revision)).rejects.toMatchObject({
      name: "VersionConflictError",
    });
    expect(await readFile(filePath, "utf8")).toBe('{"value":2}\n');
  });

  it("未知 UTF-8 外部内容也会触发版本冲突而不会被覆盖", async () => {
    const filePath = await createFilePath();
    const store = createVersionedJsonStore<{ value: number }>(filePath);
    const written = await store.write({ value: 1 });
    await writeFile(filePath, "这不是 JSON\n", "utf8");

    await expect(store.write({ value: 2 }, written.revision)).rejects.toMatchObject({
      name: "VersionConflictError",
    });
    expect(await readFile(filePath, "utf8")).toBe("这不是 JSON\n");
  });

  it("同一版本的并发写入只允许一个提交", async () => {
    const filePath = await createFilePath();
    const store = createVersionedJsonStore<{ value: number }>(filePath);
    const initial = await store.write({ value: 1 });

    const results = await Promise.allSettled([
      store.write({ value: 2 }, initial.revision),
      store.write({ value: 3 }, initial.revision),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { name: "VersionConflictError" },
    });
    expect([2, 3]).toContain((await store.read()).value?.value);
  });

  it("按版本删除文件且不遗留原子写入临时文件", async () => {
    const filePath = await createFilePath();
    const store = createVersionedJsonStore<{ value: number }>(filePath);
    const written = await store.write({ value: 1 });

    await store.remove(written.revision);

    expect((await store.read()).exists).toBe(false);
    expect((await readdir(join(filePath, ".."))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
