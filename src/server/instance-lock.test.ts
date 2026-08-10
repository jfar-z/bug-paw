// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { acquireInstanceLock } from "./instance-lock";

describe("BugPaw 服务实例锁", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("同一数据目录同时只能被一个服务实例持有", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-instance-lock-"));
    temporaryRoots.push(root);
    const first = await acquireInstanceLock(root);

    await expect(acquireInstanceLock(root, { retryWindowMs: 0 })).rejects.toMatchObject({
      code: "INSTANCE_ALREADY_RUNNING",
    });

    await first.release();
  });

  it("释放操作幂等且释放后可重新取得锁", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-instance-lock-"));
    temporaryRoots.push(root);
    const first = await acquireInstanceLock(root);

    await first.release();
    await first.release();
    const second = await acquireInstanceLock(root);

    await second.release();
  });

  it("重建中的新实例会等待已有实例释放数据目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-instance-lock-"));
    temporaryRoots.push(root);
    const first = await acquireInstanceLock(root);

    const second = acquireInstanceLock(root, { retryWindowMs: 200, retryIntervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await first.release();

    await (await second).release();
  });

  it("交接等待耗尽后拒绝启动第二个实例", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-instance-lock-"));
    temporaryRoots.push(root);
    const first = await acquireInstanceLock(root);

    await expect(acquireInstanceLock(root, { retryWindowMs: 30, retryIntervalMs: 10 })).rejects.toMatchObject({
      code: "INSTANCE_ALREADY_RUNNING",
    });

    await first.release();
  });
});
