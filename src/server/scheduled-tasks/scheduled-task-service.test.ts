// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createScheduledTaskRepository } from "./scheduled-task-repository";
import { createScheduledTaskService } from "./scheduled-task-service";
import { DomainError } from "../core/errors";

const databases: Database[] = [];
afterEach(() => { databases.splice(0).forEach((database) => database.close()); vi.useRealTimers(); });

describe("定时任务执行服务", () => {

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
