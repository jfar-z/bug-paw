// @vitest-environment node

import { describe, expect, it } from "vitest";
import { ResourceTaskManager } from "./resource-service";

describe("ResourceTaskManager", () => {
  it("失败任务以脱敏 failed 事件结束", async () => {
    const tasks = new ResourceTaskManager();
    const id = tasks.start("安装", async (log) => { log("token=super-secret-value"); throw new Error("https://user:pass@example.com failed"); });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = tasks.history(id) ?? [];
    expect(events.at(-1)).toMatchObject({ type: "failed", code: "RESOURCE_TASK_FAILED" });
    expect(JSON.stringify(events)).not.toMatch(/super-secret-value|user:pass/);
  });

  it("每个任务最多保留 2000 条日志且结束后拒绝迟到日志", async () => {
    const tasks = new ResourceTaskManager();
    let lateLog: ((line: string) => void) | undefined;
    const id = tasks.start("批量安装", async (log) => {
      lateLog = log;
      for (let index = 0; index < 2_010; index += 1) log(`line-${index}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeLate = tasks.history(id) ?? [];

    lateLog?.("late-line");

    const afterLate = tasks.history(id) ?? [];
    expect(afterLate).toHaveLength(beforeLate.length);
    expect(afterLate.filter((event) => event.type === "log")).toHaveLength(2_000);
    expect(JSON.stringify(afterLate)).not.toContain("line-0\"");
    expect(JSON.stringify(afterLate)).not.toContain("late-line");
  });

  it("任务注册表达到上限时优先淘汰最旧终态，不允许活动任务无限增长", async () => {
    const tasks = new ResourceTaskManager(1);
    const first = tasks.start("第一项", async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = tasks.start("第二项", async () => undefined);

    expect(tasks.history(first)).toBeUndefined();
    expect(tasks.history(second)).toBeDefined();

    const activeTasks = new ResourceTaskManager(1);
    activeTasks.start("运行中", async () => new Promise<void>(() => undefined));
    expect(() => activeTasks.start("超出上限", async () => undefined)).toThrow(expect.objectContaining({ code: "OPERATION_ABORTED" }));
  });

  it("关闭时拒绝新任务并等待所有在途写操作", async () => {
    const tasks = new ResourceTaskManager();
    let finish: () => void = () => undefined;
    tasks.start("安装", async () => new Promise<void>((resolve) => { finish = resolve; }));

    const firstDrain = await tasks.stopAndDrain(10);
    expect(firstDrain).toBe(false);
    expect(() => tasks.start("迟到任务", async () => undefined)).toThrow(expect.objectContaining({ code: "OPERATION_ABORTED" }));
    finish();
    await expect(tasks.stopAndDrain()).resolves.toBe(true);
  });

  it("单行与单任务日志同时受 UTF-8 字节预算保护", async () => {
    const tasks = new ResourceTaskManager();
    const id = tasks.start("大量日志", async (log) => {
      for (let index = 0; index < 200; index += 1) log("🧪".repeat(10_000));
    });
    await tasks.stopAndDrain();
    const logs = (tasks.history(id) ?? []).filter((event) => event.type === "log");
    expect(logs.every((event) => Buffer.byteLength(event.line) <= 16 * 1024)).toBe(true);
    expect(logs.reduce((sum, event) => sum + Buffer.byteLength(event.line), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });
});
