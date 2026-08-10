// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createScheduledTaskRepository } from "./scheduled-task-repository";
import { createScheduledTaskService } from "./scheduled-task-service";

const databases: Database[] = [];
afterEach(() => { databases.splice(0).forEach((database) => database.close()); vi.useRealTimers(); });

describe("定时任务执行服务", () => {
  it("更新不存在的任务时保留未找到语义", async () => {
    const service = createScheduledTaskService({
      store: await createStore(),
      acquireRuntime: async () => ({ runtime: { createSession: async () => ({ id: "unused" }), startPrompt: async () => undefined }, release: vi.fn() }),
    });

    await expect(service.update("missing-task", { name: "不会创建" })).resolves.toBeUndefined();
  });

  it("拒绝把跨重启任务绑定到尚无 Pi JSONL 的空会话", async () => {
    const store = await createStore();
    const sessionIsPersisted = vi.fn(async () => false);
    const service = createScheduledTaskService({
      store,
      sessionIsPersisted,
      acquireRuntime: async () => ({ runtime: { createSession: async () => ({ id: "unused" }), startPrompt: async () => undefined }, release: vi.fn() }),
    });

    await expect(service.create({
      agentId: "writer",
      name: "空会话任务",
      prompt: "不应保存",
      enabled: true,
      schedule: { type: "interval", unit: "hour", value: 1 },
      target: { type: "existing_session", sessionId: "empty-session" },
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(store.listAllTasks()).resolves.toEqual([]);
    expect(sessionIsPersisted).toHaveBeenCalledWith("writer", "empty-session");
  });

  it("在 Agent 空闲后才将新会话任务记录为完成", async () => {
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "日报", prompt: "整理日报", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    let becameIdle: (() => void) | undefined;
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session-new" })),
      startPrompt: vi.fn(async () => ({ status: "running" })),
      isBusy: vi.fn(() => false),
      onIdle: vi.fn((listener: () => void) => { becameIdle = listener; return () => undefined; }),
    };
    const service = createScheduledTaskService({ store, acquireRuntime: async () => ({ runtime, release: vi.fn() }) });
    const runPromise = service.runNow(task.id);
    await vi.waitFor(() => expect(runtime.startPrompt).toHaveBeenCalledWith("session-new", expect.stringContaining("这是定时任务发出的消息")));
    expect((await store.listRuns(task.id))[0]?.status).toBe("running");
    becameIdle?.();
    const run = await runPromise;
    expect(run.status).toBe("completed");
  });

  it("新会话归属写入失败时删除孤儿 Session 并记录失败", async () => {
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "失败任务", prompt: "整理日报", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session-orphan" })),
      discardUnassignedSession: vi.fn(async () => undefined),
      startPrompt: vi.fn(async () => ({ status: "completed" })),
    };
    const service = createScheduledTaskService({
      store,
      acquireRuntime: async () => ({ runtime, release: vi.fn() }),
      assignSession: vi.fn(async () => { throw new Error("database unavailable"); }),
    });

    await expect(service.runNow(task.id)).resolves.toMatchObject({ status: "failed" });
    expect(runtime.discardUnassignedSession).toHaveBeenCalledWith("session-orphan");
    expect(runtime.startPrompt).not.toHaveBeenCalled();
  });


  it("计划触发后会从实际触发时间重新计算下一次执行时间", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "日报", prompt: "整理日报", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    await store.updateTask(task.id, { nextRunAt: "2026-08-06T23:00:00.000Z" } as never);
    const service = createScheduledTaskService({ store, acquireRuntime: async () => ({ runtime: { createSession: async () => ({ id: "session-new" }), startPrompt: async () => ({ status: "completed" }) }, release: vi.fn() }) });
    await service.runNow(task.id, "scheduled");
    const updated = await store.getTask(task.id);
    expect(updated?.lastRunAt).toBe("2026-08-07T00:00:00.000Z");
    expect(updated?.nextRunAt).toBe("2026-08-07T01:00:00.000Z");
  });

  it("定时器触发的后台异常通过结构化出口报告而不是形成未处理拒绝", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "失败任务", prompt: "失败", enabled: true, schedule: { type: "once", runAt: "2026-08-07T00:00:01.000Z" }, target: { type: "new_session", archiveAfterCompletion: false } });
    const onBackgroundError = vi.fn();
    const service = createScheduledTaskService({
      store,
      acquireRuntime: async () => { throw new Error("runtime unavailable"); },
      onBackgroundError,
    });
    await service.start();
    store.getTask = vi.fn(async () => { throw new Error("repository unavailable"); });
    await vi.advanceTimersByTimeAsync(1_100);

    expect(onBackgroundError).toHaveBeenCalledWith(expect.objectContaining({
      code: "SCHEDULED_TASK_BACKGROUND_FAILED",
      taskId: task.id,
    }));
    await service.stopAndDrain();
  });

  it("停机时中止活跃 Runtime，等待失败状态落盘后再完成排空", async () => {
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "长任务", prompt: "持续生成", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    let becameIdle: (() => void) | undefined;
    const abortAll = vi.fn(async () => 1);
    const release = vi.fn();
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session-long" })),
      startPrompt: vi.fn(async () => ({ status: "running" })),
      onIdle: vi.fn((listener: () => void) => { becameIdle = listener; return () => undefined; }),
      abortAll,
    };
    const service = createScheduledTaskService({ store, acquireRuntime: async () => ({ runtime, release }) });
    const running = service.runNow(task.id);
    await vi.waitFor(() => expect(runtime.startPrompt).toHaveBeenCalledOnce());

    await expect(service.stopAndDrain()).resolves.toBe(true);
    const result = await running;

    expect(abortAll).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(result.status).toBe("failed");
    expect(result.reason).toContain("服务正在关闭");
    await expect(service.runNow(task.id)).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    becameIdle?.();
  });

  it("Runtime 中止调用挂起但执行终态已落盘时仍可安全排空", async () => {
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "挂起任务", prompt: "持续生成", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session-hanging" })),
      startPrompt: vi.fn(async () => ({ status: "running" })),
      onIdle: vi.fn(() => () => undefined),
      abortAll: vi.fn(() => new Promise<number>(() => undefined)),
    };
    const service = createScheduledTaskService({ store, acquireRuntime: async () => ({ runtime, release: vi.fn() }) });
    const running = service.runNow(task.id);
    await vi.waitFor(() => expect(runtime.startPrompt).toHaveBeenCalledOnce());

    const startedAt = Date.now();
    await expect(service.stopAndDrain(30)).resolves.toBe(true);

    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(running).resolves.toMatchObject({ status: "failed" });
  });

  it("执行本身永久挂起时按关闭预算返回未排空", async () => {
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "无法落盘", prompt: "持续生成", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    const runtime = {
      createSession: vi.fn(async () => ({ id: "session-hanging" })),
      startPrompt: vi.fn(() => new Promise(() => undefined)),
      abortAll: vi.fn(async () => 1),
    };
    const service = createScheduledTaskService({ store, acquireRuntime: async () => ({ runtime, release: vi.fn() }) });
    void service.runNow(task.id);
    await vi.waitFor(() => expect(runtime.startPrompt).toHaveBeenCalledOnce());

    await expect(service.stopAndDrain(30)).resolves.toBe(false);
    expect((await store.listRuns(task.id))[0]).toMatchObject({ status: "running" });
  });

  it("运行记录首次写入失败后释放防重入状态并允许重试", async () => {
    const store = await createStore();
    const task = await store.createTask({ agentId: "writer", name: "可重试", prompt: "执行", enabled: true, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "new_session", archiveAfterCompletion: false } });
    const originalAppendRun = store.appendRun.bind(store);
    vi.spyOn(store, "appendRun").mockRejectedValueOnce(new Error("database unavailable")).mockImplementation(originalAppendRun);
    const runtime = { createSession: async () => ({ id: "session-retry" }), startPrompt: async () => ({ status: "completed" }) };
    const service = createScheduledTaskService({ store, acquireRuntime: async () => ({ runtime, release: vi.fn() }) });

    await expect(service.runNow(task.id)).rejects.toThrow("database unavailable");
    await expect(service.runNow(task.id)).resolves.toMatchObject({ status: "completed" });
  });

  async function createStore() {
    const database = createTestDatabase();
    databases.push(database);
    await createAgentRepository(database).insert({
      version: 1, id: "writer", name: "Writer", avatar: { kind: "initial", value: "W" }, description: "", status: "active",
      cwd: "/workspace/writer", allowedTools: [], createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
    });
    return createScheduledTaskRepository(database);
  }
});
