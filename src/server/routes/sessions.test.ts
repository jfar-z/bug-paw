// @vitest-environment node

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PiRuntimeGateway } from "../pi-runtime";
import type { SessionMetadataStore } from "../session-metadata";
import type { AuthService } from "./auth";
import { registerSessionRoutes } from "./sessions";

const authService: AuthService = {
  login: async () => ({ status: "invalid" }),
  logout: async () => undefined,
  isAuthenticated: async () => true,
  isInitialized: async () => true,
  getProfile: async () => undefined,
  updateProfile: async () => { throw new Error("测试未使用个人资料更新"); },
};

describe("会话路由的定时任务联动", () => {
  it("SQLite 归属写入失败时补偿删除刚创建的 Pi Session", async () => {
    const discardUnassignedSession = vi.fn(async () => undefined);
    const runtime = {
      createSession: vi.fn(async () => ({ id: "orphan", messages: [], lastEventId: 0 })),
      discardUnassignedSession,
    } as unknown as PiRuntimeGateway;
    const sessionMetadata = {
      assignAgent: vi.fn(async () => { throw new Error("database unavailable"); }),
    } as unknown as SessionMetadataStore;
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime, sessionMetadata });

    const response = await app.inject({ method: "POST", url: "/api/sessions", payload: { agentId: "default" } });

    expect(response.statusCode).toBe(500);
    expect(discardUnassignedSession).toHaveBeenCalledWith("orphan");
    await app.close();
  });

  it("会话列表返回绑定任务数量，删除前要求确认", async () => {
    const deleteSession = vi.fn(async (_sessionId: string, _deleteScheduledTasks = false) => undefined);
    const removeTasksForSession = vi.fn(async (_sessionId: string) => undefined);
    const runtime = {
      listSessions: async () => [{ id: "session-1", path: "", created: "2026-08-07T00:00:00.000Z", modified: "2026-08-07T00:00:00.000Z", messageCount: 1, firstMessage: "日报" }],
      deleteSession,
    } as unknown as PiRuntimeGateway;
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime,
      deleteSession: async (sessionId, deleteScheduledTasks) => {
        await deleteSession(sessionId, deleteScheduledTasks);
        await removeTasksForSession(sessionId);
      },
      scheduledTasks: {
        boundTasks: async () => [{ id: "task-1" }],
        removeTasksForSession,
      },
    });

    const listed = await app.inject({ method: "GET", url: "/api/sessions?agentId=default" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions[0].scheduledTaskCount).toBe(1);

    const rejected = await app.inject({ method: "DELETE", url: "/api/sessions/session-1" });
    expect(rejected.statusCode).toBe(409);
    expect(deleteSession).not.toHaveBeenCalled();

    const confirmed = await app.inject({ method: "DELETE", url: "/api/sessions/session-1?deleteScheduledTasks=true" });
    expect(confirmed.statusCode).toBe(204);
    expect(deleteSession).toHaveBeenCalledWith("session-1", true);
    expect(removeTasksForSession).toHaveBeenCalledWith("session-1");
    await app.close();
  });

  it("模型切换只修改模型，不会误触发 Session 删除服务", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const setModel = vi.fn(async () => undefined);
    const runtime = {
      openSession: vi.fn(async (id: string) => ({ id, messages: [], lastEventId: 0 })),
      setModel,
    } as unknown as PiRuntimeGateway;
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime, deleteSession });

    const response = await app.inject({
      method: "PUT",
      url: "/api/sessions/session-1/model",
      payload: { provider: "test", modelId: "model-1" },
    });

    expect(response.statusCode).toBe(204);
    expect(setModel).toHaveBeenCalledWith("session-1", "test", "model-1");
    expect(deleteSession).not.toHaveBeenCalled();
    await app.close();
  });

  it("配置事务化删除服务时由服务统一删除 Session 与绑定任务", async () => {
    const deleteSession = vi.fn(async () => undefined);
    const removeTasksForSession = vi.fn(async () => undefined);
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: {} as PiRuntimeGateway,
      deleteSession,
      scheduledTasks: { boundTasks: async () => [{ id: "task-1" }], removeTasksForSession },
    });

    const response = await app.inject({ method: "DELETE", url: "/api/sessions/session-1?deleteScheduledTasks=true" });

    expect(response.statusCode).toBe(204);
    expect(deleteSession).toHaveBeenCalledWith("session-1", true);
    expect(removeTasksForSession).not.toHaveBeenCalled();
    await app.close();
  });
});
