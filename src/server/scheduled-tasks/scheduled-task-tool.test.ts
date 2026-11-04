// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { Check } from "typebox/value";
import { createTestDatabase } from "../database/test-database";
import { createAgentRepository } from "../agents/agent-repository";
import { createSessionRepository } from "../sessions/session-repository";
import { createScheduledTaskRepository } from "./scheduled-task-repository";
import { createScheduledTaskService } from "./scheduled-task-service";
import { createScheduledTasksTool } from "./scheduled-task-tool";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

/** 使用真实服务和内存数据库验证范围校验，无生产数据或调度副作用。 */
async function fixture() {
  const db = createTestDatabase();
  for (const id of ["writer", "other"]) {
    await createAgentRepository(db).insert({ version: 1, id, name: id, avatar: { kind: "initial", value: "W" }, description: "", status: "active", cwd: `/workspace/${id}`, allowedTools: [], createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z" });
  }
  for (const [id, owner] of [["session-a", "writer"], ["session-b", "writer"], ["session-other", "other"]]) {
    await createSessionRepository(db).assign(id!, owner!, "2026-08-07T00:00:00.000Z");
  }
  const store = createScheduledTaskRepository(db);
  const service = createScheduledTaskService({ store, acquireRuntime: async () => { throw new Error("测试禁止启动调度运行"); }, sessionIsPersisted: async () => true });
  cleanups.push(async () => { await service.stopAndDrain(); db.close(); });
  const tool = createScheduledTasksTool({ agentId: "writer", sessionId: "session-a" }, service);
  type Params = {
    action: "list" | "create" | "update" | "delete";
    scope: "current_session" | "agent";
    taskId: string | null;
    name: string | null;
    prompt: string | null;
    enabled: boolean | null;
    schedule: import("../../shared/scheduled-task-contracts").ScheduledTaskSchedule | null;
    target: import("../../shared/scheduled-task-contracts").WritableScheduledTaskTarget | { type: "current_session" } | null;
  };
  const base: Params = { action: "list", scope: "current_session", taskId: null, name: null, prompt: null, enabled: null, schedule: null, target: null };
  const create: Partial<Params> = { action: "create", name: "提醒", prompt: "整理日报", enabled: false, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "current_session" } };
  const call = async (patch: Partial<Params> = {}) => {
    const result = await tool.execute("call", { ...base, ...patch }, undefined, undefined, {} as never);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  return { store, service, tool, base, create, call };
}

describe("定时任务会话范围", () => {
  it("提供兼容的 object Schema，要求显式 scope/null 并拒绝伪造身份", async () => {
    const f = await fixture();
    expect(f.tool.parameters.type).toBe("object");
    for (const key of ["anyOf", "oneOf", "allOf"]) expect(f.tool.parameters).not.toHaveProperty(key);
    expect(Check(f.tool.parameters, f.base)).toBe(true);
    expect(Check(f.tool.parameters, {})).toBe(false);
    expect(Check(f.tool.parameters, { ...f.base, scope: undefined })).toBe(false);
    expect(Check(f.tool.parameters, { ...f.base, sessionId: "session-b" })).toBe(false);
    expect(Check(f.tool.parameters, { ...f.base, ...f.create, target: { type: "current_session", sessionId: "session-b" } })).toBe(false);
  });

  it("解析当前会话目标，列表隔离并显式标记跨会话和新会话任务", async () => {
    const f = await fixture();
    const own = await f.call(f.create);
    expect(own.target).toEqual({ type: "existing_session", sessionId: "session-a" });
    await f.call({ ...f.create, scope: "agent", target: { type: "existing_session", sessionId: "session-b" } });
    await f.call({ ...f.create, scope: "agent", target: { type: "new_session", archiveAfterCompletion: false } });
    const local = await f.call();
    expect(local).toMatchObject({ scope: "current_session", currentSessionId: "session-a" });
    expect(local.tasks.map((t: { id: string }) => t.id)).toEqual([own.id]);
    const all = await f.call({ scope: "agent" });
    expect(all.tasks).toHaveLength(3);
    expect(all.tasks.filter((t: { targetsCurrentSession: boolean }) => t.targetsCurrentSession)).toHaveLength(1);
    const otherSession = createScheduledTasksTool({ agentId: "writer", sessionId: "session-b" }, f.service);
    const result = await otherSession.execute("b", f.base, undefined, undefined, {} as never);
    expect(JSON.parse((result.content[0] as { text: string }).text).tasks).toEqual([expect.objectContaining({ target: { type: "existing_session", sessionId: "session-b" }, targetsCurrentSession: true })]);
  });

  it("范围内修改保留 null 字段并能删除，找不到的任务进入错误事件", async () => {
    const f = await fixture();
    const task = await f.call(f.create);
    const updated = await f.call({ action: "update", taskId: task.id, name: "新名称" });
    expect(updated).toMatchObject({ name: "新名称", prompt: "整理日报", enabled: false });
    await f.call({ action: "delete", taskId: task.id });
    expect(await f.store.getTask(task.id)).toBeUndefined();
    await expect(f.call({ action: "delete", taskId: task.id })).rejects.toMatchObject({ code: "SCHEDULED_TASK_NOT_FOUND" });
  });

  it("拒绝当前会话范围内访问或改绑其他目标，且不产生副作用", async () => {
    const f = await fixture();
    const own = await f.call(f.create);
    const other = await f.call({ ...f.create, scope: "agent", target: { type: "existing_session", sessionId: "session-b" } });
    for (const action of ["update", "delete"] as const) {
      await expect(f.call({ action, taskId: other.id, ...(action === "update" ? { name: "错误修改" } : {}) })).rejects.toMatchObject({ code: "SCHEDULED_TASK_NOT_FOUND" });
    }
    await expect(f.call({ action: "update", taskId: own.id, target: { type: "existing_session", sessionId: "session-b" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(f.call({ ...f.create, target: { type: "new_session", archiveAfterCompletion: false } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await f.store.getTask(own.id))?.target).toEqual(own.target);
    expect((await f.store.getTask(other.id))?.name).toBe("提醒");
    await f.call({ action: "delete", scope: "agent", taskId: other.id });
    expect(await f.store.getTask(other.id)).toBeUndefined();
  });

  it("Agent 范围也不能访问其他 Agent 或绑定其会话", async () => {
    const f = await fixture();
    const external = await f.store.createTask({ agentId: "other", name: "其他任务", prompt: "其他内容", enabled: false, schedule: { type: "interval", unit: "hour", value: 1 }, target: { type: "existing_session", sessionId: "session-other" } });
    await expect(f.call({ ...f.create, scope: "agent", target: { type: "existing_session", sessionId: "session-other" } })).rejects.toMatchObject({ code: "SESSION_AGENT_CONFLICT" });
    await expect(f.call({ action: "delete", scope: "agent", taskId: external.id })).rejects.toMatchObject({ code: "SCHEDULED_TASK_NOT_FOUND" });
    expect((await f.call({ scope: "agent" })).tasks).toEqual([]);
  });

  it("无关字段、缺少条件字段和空修改均报错且不会写入", async () => {
    const f = await fixture();
    await expect(f.call({ ...f.create, prompt: null })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(f.call({ ...f.create, taskId: "invented" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(f.call({ name: "invented" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await f.store.listAllTasks()).toHaveLength(0);
    const task = await f.call(f.create);
    await expect(f.call({ action: "update", taskId: task.id })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(f.call({ action: "delete", taskId: task.id, enabled: false })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(await f.store.getTask(task.id)).toBeDefined();
  });

  it.each(["update", "delete"] as const)("%s 在预检后任务被改绑时由写事务再次阻止", async (action) => {
    const f = await fixture();
    const task = await f.call(f.create);
    const original = f.store[action === "update" ? "updateTask" : "removeTask"].bind(f.store);
    if (action === "update") {
      vi.spyOn(f.store, "updateTask").mockImplementationOnce(async (id, input, access) => {
        await (original as typeof f.store.updateTask)(id, { target: { type: "existing_session", sessionId: "session-b" } });
        return (original as typeof f.store.updateTask)(id, input, access);
      });
    } else {
      vi.spyOn(f.store, "removeTask").mockImplementationOnce(async (id, access) => {
        await f.store.updateTask(id, { target: { type: "existing_session", sessionId: "session-b" } });
        return (original as typeof f.store.removeTask)(id, access);
      });
    }
    await expect(f.call({ action, taskId: task.id, ...(action === "update" ? { name: "不应写入" } : {}) })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await f.store.getTask(task.id)).toMatchObject({ name: "提醒", target: { type: "existing_session", sessionId: "session-b" } });
  });
});
