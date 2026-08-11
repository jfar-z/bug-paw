// @vitest-environment node

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PiRuntimeGateway } from "../pi-runtime";
import type { SessionMetadataStore } from "../session-metadata";
import type { SessionBulkService } from "../sessions/session-bulk-service";
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
  it("按服务端固定游标读取当前分支的上一页历史", async () => {
    const loadHistoryPage = vi.fn(async () => ({
      sessionId: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, turnCount: 0 },
    }));
    const openSession = vi.fn(async () => ({
      id: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, turnCount: 0 },
      lastEventId: 0,
    }));
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime: { openSession, loadHistoryPage } as unknown as PiRuntimeGateway });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/history?before=user-21&branch=branch-a",
    });

    expect(response.statusCode).toBe(200);
    expect(loadHistoryPage).toHaveBeenCalledWith("session-1", "user-21", "branch-a");
    const invalid = await app.inject({ method: "GET", url: "/api/sessions/session-1/history?before=user-21" });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });

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
    const runtime = {
      listSessions: async () => [{ id: "session-1", path: "", created: "2026-08-07T00:00:00.000Z", modified: "2026-08-07T00:00:00.000Z", messageCount: 1, firstMessage: "日报" }],
    } as unknown as PiRuntimeGateway;
    const sessionBulk = bulkServiceDouble({ tasks: [{ id: "task-1", name: "日报", sessionId: "session-1" }] });
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime,
      sessionBulk,
      scheduledTasks: {
        boundTasks: async () => [{ id: "task-1" }],
      },
    });

    const listed = await app.inject({ method: "GET", url: "/api/sessions?agentId=default" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().sessions[0].scheduledTaskCount).toBe(1);

    const rejected = await app.inject({ method: "DELETE", url: "/api/sessions/session-1" });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().error.message).toContain("停用任务");
    expect(sessionBulk.execute).not.toHaveBeenCalled();

    const confirmed = await app.inject({ method: "DELETE", url: "/api/sessions/session-1?confirmBoundTasks=true" });
    expect(confirmed.statusCode).toBe(204);
    expect(sessionBulk.execute).toHaveBeenCalledWith({
      action: "delete",
      target: { mode: "selected", sessionIds: ["session-1"] },
      fingerprint: "fingerprint-1",
    });
    await app.close();
  });

  it("模型切换只修改模型，不会误触发 Session 删除服务", async () => {
    const sessionBulk = bulkServiceDouble();
    const setModel = vi.fn(async () => undefined);
    const runtime = {
      openSession: vi.fn(async (id: string) => ({ id, messages: [], lastEventId: 0 })),
      setModel,
    } as unknown as PiRuntimeGateway;
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime, sessionBulk });

    const response = await app.inject({
      method: "PUT",
      url: "/api/sessions/session-1/model",
      payload: { provider: "test", modelId: "model-1" },
    });

    expect(response.statusCode).toBe(204);
    expect(setModel).toHaveBeenCalledWith("session-1", "test", "model-1");
    expect(sessionBulk.execute).not.toHaveBeenCalled();
    await app.close();
  });

  it("批量预览与执行接口透传确认指纹", async () => {
    const sessionBulk = bulkServiceDouble();
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: {} as PiRuntimeGateway,
      sessionBulk,
    });

    const preview = await app.inject({
      method: "POST",
      url: "/api/sessions/bulk/preview",
      payload: { action: "archive", target: { mode: "selected", sessionIds: ["session-1", "session-2"] } },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/bulk",
      payload: { action: "archive", target: { mode: "selected", sessionIds: ["session-1", "session-2"] }, fingerprint: "fingerprint-1" },
    });

    expect(preview.statusCode).toBe(200);
    expect(sessionBulk.preview).toHaveBeenCalledWith("archive", { mode: "selected", sessionIds: ["session-1", "session-2"] });
    expect(response.statusCode).toBe(200);
    expect(sessionBulk.execute).toHaveBeenCalledWith({
      action: "archive",
      target: { mode: "selected", sessionIds: ["session-1", "session-2"] },
      fingerprint: "fingerprint-1",
    });
    await app.close();
  });

  it("批量接口拒绝空集合和超过上限的 ID 集合", async () => {
    const sessionBulk = bulkServiceDouble();
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime: {} as PiRuntimeGateway, sessionBulk });

    const empty = await app.inject({ method: "POST", url: "/api/sessions/bulk/preview", payload: { action: "delete", target: { mode: "selected", sessionIds: [] } } });
    const excessive = await app.inject({
      method: "POST",
      url: "/api/sessions/bulk/preview",
      payload: { action: "delete", target: { mode: "selected", sessionIds: Array.from({ length: 201 }, (_, index) => `session-${index}`) } },
    });

    expect(empty.statusCode).toBe(400);
    expect(excessive.statusCode).toBe(400);
    expect(sessionBulk.preview).not.toHaveBeenCalled();
    await app.close();
  });

  it("批量接口接受全部归档恢复与删除目标", async () => {
    const sessionBulk = bulkServiceDouble();
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime: {} as PiRuntimeGateway, sessionBulk });

    const preview = await app.inject({
      method: "POST",
      url: "/api/sessions/bulk/preview",
      payload: { action: "restore", target: { mode: "all_archived", agentId: "agent-1" } },
    });
    const executed = await app.inject({
      method: "POST",
      url: "/api/sessions/bulk",
      payload: { action: "delete", target: { mode: "all_archived", agentId: "agent-1" }, fingerprint: "fingerprint-1" },
    });

    expect(preview.statusCode).toBe(200);
    expect(executed.statusCode).toBe(200);
    expect(sessionBulk.preview).toHaveBeenCalledWith("restore", { mode: "all_archived", agentId: "agent-1" });
    expect(sessionBulk.execute).toHaveBeenCalledWith({
      action: "delete",
      target: { mode: "all_archived", agentId: "agent-1" },
      fingerprint: "fingerprint-1",
    });
    await app.close();
  });

  it("批量接口拒绝不合法动作范围组合与伪造字段", async () => {
    const sessionBulk = bulkServiceDouble();
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime: {} as PiRuntimeGateway, sessionBulk });
    const payloads = [
      { action: "restore", target: { mode: "selected", sessionIds: ["session-1"] } },
      { action: "archive", target: { mode: "all_archived", agentId: "agent-1" } },
      { action: "delete", target: { mode: "all_archived", agentId: "" } },
      { action: "delete", target: { mode: "all_archived", agentId: "agent-1", sessionIds: ["forged"] } },
    ];

    for (const payload of payloads) {
      const response = await app.inject({ method: "POST", url: "/api/sessions/bulk/preview", payload });
      expect(response.statusCode).toBe(400);
    }
    expect(sessionBulk.preview).not.toHaveBeenCalled();
    await app.close();
  });
});

function bulkServiceDouble(overrides: { tasks?: Array<{ id: string; name: string; sessionId: string }> } = {}): SessionBulkService {
  return {
    preview: vi.fn(async (action, target) => ({
      action,
      target,
      sessionCount: target.mode === "selected" ? target.sessionIds.length : 2,
      tasks: overrides.tasks ?? [],
      fingerprint: "fingerprint-1",
    })),
    execute: vi.fn(async (input) => ({
      action: input.action,
      sessionCount: input.target.mode === "selected" ? input.target.sessionIds.length : 2,
      affectedTaskCount: overrides.tasks?.length ?? 0,
    })),
  };
}
