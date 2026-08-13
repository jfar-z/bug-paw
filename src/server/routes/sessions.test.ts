// @vitest-environment node

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { DomainError } from "../core/errors";
import { PiRuntimeError, type PiRuntimeGateway } from "../pi-runtime";
import { SessionTextError } from "../session-text-service";
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
  it("按固定页面大小搜索当前 Agent 的会话文本", async () => {
    const searchSessionText = vi.fn(async () => ({ hits: [], hasMore: false }));
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: { searchSessionText } as unknown as PiRuntimeGateway,
    });

    const empty = await app.inject({ method: "GET", url: "/api/sessions/search?agentId=agent-a&query=" });
    const excessive = await app.inject({ method: "GET", url: `/api/sessions/search?agentId=agent-a&query=${"x".repeat(501)}` });
    const valid = await app.inject({ method: "GET", url: "/api/sessions/search?agentId=agent-a&query=needle&cursor=cursor-1" });

    expect(empty.statusCode).toBe(400);
    expect(excessive.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
    expect(searchSessionText).toHaveBeenCalledWith({ query: "needle", limit: 30, cursor: "cursor-1" });
    await app.close();
  });

  it("搜索接口拒绝缺失 Agent、未认证请求和无效游标", async () => {
    const searchSessionText = vi.fn(async () => {
      throw new SessionTextError("SESSION_SEARCH_CURSOR_INVALID", "游标无效");
    });
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: { searchSessionText } as unknown as PiRuntimeGateway,
    });

    const missingAgent = await app.inject({ method: "GET", url: "/api/sessions/search?query=needle" });
    const invalidCursor = await app.inject({ method: "GET", url: "/api/sessions/search?agentId=agent-a&query=needle&cursor=expired" });

    expect(missingAgent.statusCode).toBe(400);
    expect(invalidCursor.statusCode).toBe(400);
    expect(invalidCursor.json()).toMatchObject({ error: { code: "SESSION_SEARCH_CURSOR_INVALID" } });
    await app.close();

    const anonymousApp = Fastify();
    registerSessionRoutes(anonymousApp, {
      authService: { ...authService, isAuthenticated: async () => false },
      runtime: { searchSessionText } as unknown as PiRuntimeGateway,
    });
    expect((await anonymousApp.inject({ method: "GET", url: "/api/sessions/search?agentId=agent-a&query=needle" })).statusCode).toBe(401);
    await anonymousApp.close();
  });

  it("搜索接口把不可用 Agent 映射为稳定错误", async () => {
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtimeSupervisor: {
        acquire: vi.fn(async () => { throw new DomainError("AGENT_NOT_FOUND", "Agent 不存在"); }),
      } as never,
    });

    const response = await app.inject({ method: "GET", url: "/api/sessions/search?agentId=missing&query=needle" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "AGENT_NOT_FOUND" } });
    await app.close();
  });

  it("按目标消息读取历史窗口并支持向后分页", async () => {
    const openSession = vi.fn(async () => ({
      id: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      lastEventId: 0,
    }));
    const loadHistoryTarget = vi.fn(async () => ({
      sessionId: "session-1",
      targetEntryId: "assistant-10",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: true, hasMoreAfter: true, turnCount: 20 },
    }));
    const loadHistoryPageAfter = vi.fn(async () => ({
      sessionId: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: true, hasMoreAfter: false, turnCount: 5 },
    }));
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: { openSession, loadHistoryTarget, loadHistoryPageAfter } as unknown as PiRuntimeGateway,
    });

    const target = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/history-window?entryId=assistant-10&branch=branch-a",
    });
    const after = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/history?after=assistant-20&branch=branch-a",
    });
    const ambiguous = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/history?before=user-1&after=assistant-20&branch=branch-a",
    });
    const missingBranch = await app.inject({ method: "GET", url: "/api/sessions/session-1/history?after=assistant-20" });
    const missingTarget = await app.inject({ method: "GET", url: "/api/sessions/session-1/history-window?branch=branch-a" });

    expect(target.statusCode).toBe(200);
    expect(after.statusCode).toBe(200);
    expect(ambiguous.statusCode).toBe(400);
    expect(missingBranch.statusCode).toBe(400);
    expect(missingTarget.statusCode).toBe(400);
    expect(loadHistoryTarget).toHaveBeenCalledWith("session-1", "assistant-10", "branch-a");
    expect(loadHistoryPageAfter).toHaveBeenCalledWith("session-1", "assistant-20", "branch-a");
    await app.close();
  });

  it.each([
    ["SESSION_NOT_FOUND", 404],
    ["SESSION_ENTRY_NOT_FOUND", 404],
    ["SESSION_BRANCH_CHANGED", 409],
  ] as const)("目标历史错误 %s 映射为稳定状态", async (code, statusCode) => {
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: {
        openSession: vi.fn(async () => ({ id: "session-1", messages: [], history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 }, lastEventId: 0 })),
        loadHistoryTarget: vi.fn(async () => { throw new PiRuntimeError(code, code); }),
      } as unknown as PiRuntimeGateway,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/history-window?entryId=assistant-10&branch=branch-a",
    });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code } });
    await app.close();
  });

  it("按服务端固定游标读取当前分支的上一页历史", async () => {
    const loadHistoryPage = vi.fn(async () => ({
      sessionId: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    }));
    const openSession = vi.fn(async () => ({
      id: "session-1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
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

  it("历史分支 token 过期时返回稳定冲突错误", async () => {
    const runtime = {
      openSession: vi.fn(async () => ({ id: "session-1", messages: [], history: { branchToken: "new", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 }, lastEventId: 0 })),
      loadHistoryPage: vi.fn(async () => { throw new PiRuntimeError("SESSION_HISTORY_STALE", "会话分支已变化"); }),
    } as unknown as PiRuntimeGateway;
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime });

    const response = await app.inject({ method: "GET", url: "/api/sessions/session-1/history?before=user-21&branch=old" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "SESSION_HISTORY_STALE" } });
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

  it("会话列表合并置顶状态并返回稳定顺序", async () => {
    const runtime = {
      listSessions: vi.fn(async () => [
        { id: "normal-old", modified: "2026-08-01T00:00:00.000Z", messageCount: 1, firstMessage: "普通旧会话" },
        { id: "pin-b", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "置顶 B" },
        { id: "normal-new", modified: "2026-08-04T00:00:00.000Z", messageCount: 1, firstMessage: "普通新会话" },
        { id: "pin-a", modified: "2026-08-03T00:00:00.000Z", messageCount: 1, firstMessage: "置顶 A" },
      ]),
    } as unknown as PiRuntimeGateway;
    const sessionMetadata = {
      listPinnedIds: vi.fn(async () => ["pin-a", "pin-b"]),
    } as unknown as SessionMetadataStore;
    const app = Fastify();
    registerSessionRoutes(app, { authService, runtime, sessionMetadata });

    const response = await app.inject({ method: "GET", url: "/api/sessions?agentId=default" });

    expect(response.statusCode).toBe(200);
    expect(response.json().sessions.map(({ id, pinned }: { id: string; pinned: boolean }) => ({ id, pinned }))).toEqual([
      { id: "pin-a", pinned: true },
      { id: "pin-b", pinned: true },
      { id: "normal-new", pinned: false },
      { id: "normal-old", pinned: false },
    ]);
    await app.close();
  });

  it("置顶接口只写元数据且不打开 Pi Session", async () => {
    const pin = vi.fn(async () => undefined);
    const unpin = vi.fn(async () => undefined);
    const openSession = vi.fn();
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: { openSession } as unknown as PiRuntimeGateway,
      sessionMetadata: { pin, unpin } as unknown as SessionMetadataStore,
    });

    const pinned = await app.inject({ method: "PUT", url: "/api/sessions/session-1/pin" });
    const unpinned = await app.inject({ method: "DELETE", url: "/api/sessions/session-1/pin" });

    expect(pinned.statusCode).toBe(204);
    expect(unpinned.statusCode).toBe(204);
    expect(pin).toHaveBeenCalledWith("session-1");
    expect(unpin).toHaveBeenCalledWith("session-1");
    expect(openSession).not.toHaveBeenCalled();
    await app.close();
  });

  it.each([
    ["SESSION_ARCHIVED", 409],
    ["SESSION_NOT_FOUND", 404],
  ] as const)("置顶失败时把 %s 映射为稳定状态", async (code, statusCode) => {
    const app = Fastify();
    registerSessionRoutes(app, {
      authService,
      runtime: {} as PiRuntimeGateway,
      sessionMetadata: {
        pin: vi.fn(async () => { throw new DomainError(code, code); }),
      } as unknown as SessionMetadataStore,
    });

    const response = await app.inject({ method: "PUT", url: "/api/sessions/session-1/pin" });

    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toMatchObject({ error: { code } });
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
