// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createScheduledTaskRepository } from "./scheduled-task-repository";
import { createSessionRepository } from "../sessions/session-repository";

describe("ScheduledTaskRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("持久化任务、运行记录并级联删除历史", async () => {
    const { database, repository } = createFixture();
    const task = await repository.createTask({
      agentId: "a1",
      name: "巡检",
      prompt: "检查状态",
      enabled: true,
      schedule: { type: "interval", unit: "hour", value: 1 },
      target: { type: "new_session", archiveAfterCompletion: true },
    });
    await repository.appendRun({
      taskId: task.id,
      trigger: "manual",
      status: "completed",
      startedAt: "2026-08-07T00:00:00.000Z",
      finishedAt: "2026-08-07T00:01:00.000Z",
      prompt: "检查状态",
    });

    expect(await repository.listTasks("a1")).toHaveLength(1);
    expect(await repository.listRuns(task.id)).toHaveLength(1);
    await repository.removeTask(task.id);
    expect(database.read("SELECT id FROM scheduled_task_runs")).toEqual([]);
  });

  it("运行历史同时满足每任务和全局保留上限", async () => {
    const { repository } = createFixture();
    const first = await repository.createTask(taskInput("一"));
    const second = await repository.createTask(taskInput("二"));
    for (let index = 0; index < 4; index += 1) {
      await repository.appendRun(runInput(first.id, index));
      await repository.appendRun(runInput(second.id, index));
    }

    await repository.pruneRuns({ perTask: 2, global: 3 });

    const firstRuns = await repository.listRuns(first.id);
    const secondRuns = await repository.listRuns(second.id);
    expect(firstRuns.length).toBeLessThanOrEqual(2);
    expect(secondRuns.length).toBeLessThanOrEqual(2);
    expect(firstRuns.length + secondRuns.length).toBe(3);
  });

  it("原子校验目标 Session 存在且属于任务 Agent", async () => {
    const { agents, sessions, repository } = createFixture();
    await agents.insert({
      version: 1,
      id: "a2",
      name: "Agent 2",
      avatar: { kind: "initial", value: "B" },
      description: "",
      status: "active",
      cwd: "/workspace/a2",
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    await sessions.assign("s2", "a2", "2026-08-07T00:00:00.000Z");

    await expect(repository.createTask({
      ...taskInput("不存在"),
      target: { type: "existing_session", sessionId: "missing" },
    })).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(repository.createTask({
      ...taskInput("归属冲突"),
      target: { type: "existing_session", sessionId: "s2" },
    })).rejects.toMatchObject({ code: "SESSION_AGENT_CONFLICT" });
    expect(await repository.listTasks("a1")).toEqual([]);
  });

  it("目标 Session 删除后由外键级联清理任务", async () => {
    const { sessions, repository } = createFixture();
    await sessions.assign("s1", "a1", "2026-08-07T00:00:00.000Z");
    const task = await repository.createTask({
      ...taskInput("绑定"),
      target: { type: "existing_session", sessionId: "s1" },
    });

    await sessions.removeWithBoundTasks("s1", true);

    expect(await repository.getTask(task.id)).toBeUndefined();
  });

  it("原目标会话已删除时拒绝直接启用并允许重新指定目标", async () => {
    const { database, repository } = createFixture();
    const timestamp = "2026-08-11T00:00:00.000Z";
    database.write(
      "INSERT INTO scheduled_tasks(id, agent_id, session_id, task_json, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)",
      ["missing-target-task", "a1", JSON.stringify({
        ...taskInput("缺失目标"),
        id: "missing-target-task",
        enabled: false,
        target: { type: "deleted_session", sessionId: "deleted-session", sessionName: "已删除日报会话" },
        createdAt: timestamp,
        updatedAt: timestamp,
      }), timestamp, timestamp],
    );

    await expect(repository.updateTask("missing-target-task", { enabled: true }))
      .rejects.toMatchObject({ code: "SCHEDULED_TASK_TARGET_MISSING" });

    await expect(repository.updateTask("missing-target-task", {
      enabled: true,
      target: { type: "new_session", archiveAfterCompletion: false },
    })).resolves.toMatchObject({
      enabled: true,
      target: { type: "new_session", archiveAfterCompletion: false },
    });
  });

  function createFixture() {
    const database = createTestDatabase();
    databases.push(database);
    const agents = createAgentRepository(database);
    void agents.insert({
      version: 1,
      id: "a1",
      name: "Agent",
      avatar: { kind: "initial", value: "A" },
      description: "",
      status: "active",
      cwd: "/workspace/a1",
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    });
    return {
      database,
      agents,
      sessions: createSessionRepository(database),
      repository: createScheduledTaskRepository(database),
    };
  }
});

function taskInput(name: string) {
  return {
    agentId: "a1",
    name,
    prompt: name,
    enabled: true,
    schedule: { type: "interval" as const, unit: "hour" as const, value: 1 },
    target: { type: "new_session" as const, archiveAfterCompletion: false },
  };
}

function runInput(taskId: string, index: number) {
  const startedAt = `2026-08-07T00:00:0${index}.000Z`;
  return { taskId, trigger: "manual" as const, status: "completed" as const, startedAt, finishedAt: startedAt, prompt: "run" };
}
