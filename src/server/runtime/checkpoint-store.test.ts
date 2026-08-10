// @vitest-environment node

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunCheckpointStore, type RunCheckpoint } from "./checkpoint-store";
import { createDataPaths } from "../paths";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-run-store-"));
  temporaryRoots.push(root);
  const paths = await createDataPaths(root);
  return { paths, store: createRunCheckpointStore(paths.runDir) };
}

function runningCheckpoint(sessionId = "session-1"): RunCheckpoint {
  return {
    version: 1,
    runId: "run-1",
    sessionId,
    status: "running",
    startedAt: "2026-08-05T08:00:00.000Z",
    lastEventId: 2,
    messages: [{ role: "user", content: "你好" }],
    events: [],
  };
}

describe("运行检查点存储", () => {
  it("在数据根目录内原子保存并读取检查点", async () => {
    const { paths, store } = await createFixture();
    const checkpoint = runningCheckpoint();

    await store.save(checkpoint);

    expect(await store.load("session-1")).toEqual(checkpoint);
    expect(JSON.parse(await readFile(join(paths.runDir, "session-1.json"), "utf8"))).toEqual(checkpoint);
  });

  it("拒绝可能逃逸运行目录的会话标识", async () => {
    const { store } = await createFixture();

    await expect(store.load("../outside")).rejects.toThrow("会话 ID");
    await expect(store.save(runningCheckpoint("folder/session"))).rejects.toThrow("会话 ID");
    await expect(store.remove("folder\\session")).rejects.toThrow("会话 ID");
  });

  it("启动恢复时把旧活动运行标记为 interrupted", async () => {
    const { store } = await createFixture();
    await store.save(runningCheckpoint());

    await store.markInterrupted("2026-08-05T09:00:00.000Z");

    expect(await store.load("session-1")).toMatchObject({
      status: "interrupted",
      finishedAt: "2026-08-05T09:00:00.000Z",
    });
    expect(await store.load("session-1")).not.toHaveProperty("messages");
  });

  it("删除检查点是幂等操作", async () => {
    const { paths, store } = await createFixture();
    await store.save(runningCheckpoint());

    await store.remove("session-1");
    await store.remove("session-1");

    await expect(access(join(paths.runDir, "session-1.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
