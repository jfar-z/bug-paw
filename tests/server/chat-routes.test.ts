// @vitest-environment node

import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, PiRuntimeGateway } from "../../src/server/pi-runtime";
import { PiRuntimeError } from "../../src/server/pi-runtime";
import { createDataPaths } from "../../src/server/paths";
import { createAuthService, registerAuthRoutes } from "../../src/server/routes/auth";
import { registerChatRoutes } from "../../src/server/routes/chat";
import { registerModelRoutes } from "../../src/server/routes/models";
import { registerSessionRoutes } from "../../src/server/routes/sessions";
import { registerSetupRoutes } from "../../src/server/routes/setup";
import type { WorkspaceFileInfo, WorkspaceFileService } from "../../src/server/attachments";
import type { RuntimeSupervisor } from "../../src/server/runtime/runtime-supervisor";
import type { ChatApplicationService } from "../../src/server/chat/chat-service";
import { createSessionMetadataStore } from "../../src/server/session-metadata";
import type { AgentReferenceResolver } from "../../src/server/agent-references";
import { openDatabase } from "../../src/server/database/database";
import { runMigrations } from "../../src/server/database/migrator";
import { createIdentityRepository } from "../../src/server/identity/identity-repository";
import { createAgentRepository } from "../../src/server/agents/agent-repository";
import { createSessionRepository } from "../../src/server/sessions/session-repository";
import type { SessionBulkService } from "../../src/server/sessions/session-bulk-service";

const apps: FastifyInstance[] = [];
const temporaryRoots: string[] = [];

class FakeRuntime implements PiRuntimeGateway {
  private running = false;
  private finishCurrent?: () => void;
  lastAfterEventId?: number;
  archived = false;

  listModels = vi.fn(async () => [{ provider: "test", id: "model-1", name: "Model 1" }]);
  listCommands = vi.fn(async () => []);
  listSessions = vi.fn(async (options?: { archived?: boolean }) => {
    const wantsArchived = options?.archived ?? false;
    return wantsArchived === this.archived ? [{
      id: "session-1",
      path: "/data/pi/sessions/session-1.jsonl",
      name: "测试会话",
      created: "2026-08-05T08:00:00.000Z",
      modified: "2026-08-05T08:00:00.000Z",
      messageCount: 1,
      firstMessage: "测试",
    }] : [];
  });
  createSession = vi.fn(async () => ({ id: "session-1", messages: [], lastEventId: 0 }));
  openSession = vi.fn(async (sessionId: string) => ({ id: sessionId, messages: [], lastEventId: 0 }));
  setModel = vi.fn(async () => undefined);
  renameSession = vi.fn(async () => undefined);
  archiveSession = vi.fn(async () => { this.archived = true; });
  unarchiveSession = vi.fn(async () => { this.archived = false; });
  deleteSession = vi.fn(async () => undefined);
  dispose = vi.fn();

  prompt = vi.fn(async () => {
    if (this.running) {
      throw new PiRuntimeError("SESSION_BUSY", "会话正在生成中");
    }
    this.running = true;
    await new Promise<void>((resolve) => {
      this.finishCurrent = resolve;
    });
    this.running = false;
  });

  startPrompt = vi.fn(async (sessionId: string, text: string) => {
    if (this.running) {
      throw new PiRuntimeError("SESSION_BUSY", "会话正在生成中");
    }
    void this.prompt(sessionId, text);
    return {
      runId: "run-1",
      sessionId,
      status: "running" as const,
      startedAt: "2026-08-05T08:00:00.000Z",
    };
  });

  abort = vi.fn(async () => {
    this.finishCurrent?.();
  });

  subscribe(
    sessionId: string,
    afterOrListener: number | undefined | ((event: ChatEvent) => void),
    maybeListener?: (event: ChatEvent) => void,
  ) {
    const listener = typeof afterOrListener === "function" ? afterOrListener : maybeListener!;
    this.lastAfterEventId = typeof afterOrListener === "number" ? afterOrListener : undefined;
    listener({ type: "snapshot", id: 0, sessionId, messages: [], lastEventId: 0 });
    return vi.fn();
  }
}

/** 为路由集成测试保留 Runtime 删除断言，批量事务本身由专用测试覆盖。 */
function createSessionBulkDouble(removeSession: (sessionId: string) => Promise<void>): SessionBulkService {
  return {
    async preview(action, target) {
      return {
        action,
        target,
        sessionCount: target.mode === "selected" ? target.sessionIds.length : 0,
        tasks: [],
        fingerprint: "test-fingerprint",
      };
    },
    async execute(input) {
      const sessionIds = input.target.mode === "selected" ? input.target.sessionIds : [];
      for (const sessionId of sessionIds) await removeSession(sessionId);
      return { action: input.action, sessionCount: sessionIds.length, affectedTaskCount: 0 };
    },
  };
}

async function createTestApp(
  runtime = new FakeRuntime(),
  workspaceFiles?: WorkspaceFileService,
  referenceResolver?: AgentReferenceResolver,
  chatService?: Pick<ChatApplicationService, "startBranchTurn">,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-chat-routes-"));
  temporaryRoots.push(root);
  const paths = await createDataPaths(root);
  const app = Fastify({ logger: false });
  apps.push(app);
  await app.register(cookie);
  const authService = createAuthService(paths);
  registerSetupRoutes(app, { paths });
  registerAuthRoutes(app, { authService });
  registerModelRoutes(app, { authService, runtime });
  registerSessionRoutes(app, { authService, runtime, sessionBulk: createSessionBulkDouble((sessionId) => runtime.deleteSession(sessionId)) });
  registerChatRoutes(app, { authService, runtime, workspaceFiles, referenceResolver, chatService: chatService as ChatApplicationService | undefined, heartbeatMs: 50 });
  await app.ready();
  return { app, runtime };
}

async function initializeAndLogin(app: FastifyInstance): Promise<string> {
  await app.inject({
    method: "POST",
    url: "/api/setup",
    payload: {
      password: "local-password-123",
      confirmPassword: "local-password-123",
      provider: { type: "test", apiKey: "test-key-not-secret", defaultModel: "model-1" },
    },
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/login",
    payload: { password: "local-password-123", remember: false },
  });
  return String(login.headers["set-cookie"]).split(";", 1)[0];
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("对话 API", () => {
  it("编辑后的发送仅在确认提交时调用会话树分支服务", async () => {
    const startBranchTurn = vi.fn(async () => ({
      runId: "run-branch",
      sessionId: "session-1",
      status: "running" as const,
      startedAt: "2026-08-10T00:00:00.000Z",
    }));
    const { app } = await createTestApp(new FakeRuntime(), undefined, undefined, { startBranchTurn });
    const authCookie = await initializeAndLogin(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/branches/user-old/messages",
      headers: { cookie: authCookie },
      payload: { text: "修改后的问题", filePaths: [], references: [] },
    });

    expect(response.statusCode).toBe(202);
    expect(startBranchTurn).toHaveBeenCalledWith("session-1", "user-old", {
      text: "修改后的问题",
      filePaths: [],
      references: [],
    });
  });

  it("版本切换调用会话树导航服务并返回目标分支快照", async () => {
    const navigateHistory = vi.fn(async () => ({ id: "session-1", messages: [], lastEventId: 4 }));
    const { app } = await createTestApp(new FakeRuntime(), undefined, undefined, { navigateHistory } as never);
    const authCookie = await initializeAndLogin(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/branches/assistant-branch-leaf/navigate",
      headers: { cookie: authCookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: "session-1", messages: [], lastEventId: 4 });
    expect(navigateHistory).toHaveBeenCalledWith("session-1", "assistant-branch-leaf");
  });

  it("支持会话重命名、归档、恢复、归档列表和删除", async () => {
    const { app, runtime } = await createTestApp();
    const authCookie = await initializeAndLogin(app);

    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/sessions/session-1",
      headers: { cookie: authCookie },
      payload: { name: "项目讨论" },
    });
    expect(renamed.statusCode).toBe(204);
    expect(runtime.renameSession).toHaveBeenCalledWith("session-1", "项目讨论");

    const archived = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/archive",
      headers: { cookie: authCookie },
    });
    expect(archived.statusCode).toBe(204);

    const archivedList = await app.inject({
      method: "GET",
      url: "/api/sessions?archived=true",
      headers: { cookie: authCookie },
    });
    expect(archivedList.json()).toMatchObject({ sessions: [{ id: "session-1" }] });
    expect(runtime.listSessions).toHaveBeenCalledWith({ archived: true });

    const restored = await app.inject({
      method: "DELETE",
      url: "/api/sessions/session-1/archive",
      headers: { cookie: authCookie },
    });
    expect(restored.statusCode).toBe(204);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/sessions/session-1",
      headers: { cookie: authCookie },
    });
    expect(deleted.statusCode).toBe(204);
    expect(runtime.deleteSession).toHaveBeenCalledWith("session-1");
  });

  it("拒绝非法归档筛选和空会话名称", async () => {
    const { app } = await createTestApp();
    const authCookie = await initializeAndLogin(app);

    const filter = await app.inject({ method: "GET", url: "/api/sessions?archived=all", headers: { cookie: authCookie } });
    const rename = await app.inject({
      method: "PATCH",
      url: "/api/sessions/session-1",
      headers: { cookie: authCookie },
      payload: { name: "   " },
    });

    expect(filter.statusCode).toBe(400);
    expect(rename.statusCode).toBe(400);
  });

  it("拒绝未登录的模型和会话请求", async () => {
    const { app } = await createTestApp();

    const models = await app.inject({ method: "GET", url: "/api/models" });
    const sessions = await app.inject({ method: "POST", url: "/api/sessions" });

    expect(models.statusCode).toBe(401);
    expect(sessions.statusCode).toBe(401);
  });

  it("登录后列出模型、创建会话并切换模型", async () => {
    const { app, runtime } = await createTestApp();
    const authCookie = await initializeAndLogin(app);

    const models = await app.inject({ method: "GET", url: "/api/models", headers: { cookie: authCookie } });
    expect(models.json()).toEqual({ models: [{ provider: "test", id: "model-1", name: "Model 1" }] });

    const created = await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: authCookie } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ id: "session-1", agentId: "default", messages: [], lastEventId: 0 });

    const switched = await app.inject({
      method: "PUT",
      url: "/api/sessions/session-1/model",
      headers: { cookie: authCookie },
      payload: { provider: "test", modelId: "model-1" },
    });
    expect(switched.statusCode).toBe(204);
    expect(runtime.setModel).toHaveBeenCalledWith("session-1", "test", "model-1");
  });

  it("已有 Session 始终按持久化归属选择 Runtime，不相信消息中的 agentId", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-scoped-routes-"));
    temporaryRoots.push(root);
    const paths = await createDataPaths(root);
    const app = Fastify({ logger: false });
    apps.push(app);
    await app.register(cookie);
    const database = openDatabase(paths.databaseFile);
    runMigrations(database);
    app.addHook("onClose", async () => database.close());
    const identities = createIdentityRepository(database);
    const authService = createAuthService(paths, { identityRepository: identities });
    const agents = createAgentRepository(database);
    for (const id of ["agent-a", "agent-b"]) {
      await agents.insert({
        version: 1, id, name: id, avatar: { kind: "initial", value: "A" }, description: "", status: "active",
        cwd: `/workspace/${id}`, allowedTools: [], createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T00:00:00.000Z",
      });
    }
    const runtimeA = new FakeRuntime();
    const runtimeB = new FakeRuntime();
    runtimeA.createSession.mockResolvedValueOnce({ id: "session-a", messages: [], lastEventId: 0 });
    runtimeB.createSession.mockResolvedValueOnce({ id: "session-b", messages: [], lastEventId: 0 });
    const runtimeSupervisor = {
      acquire: vi.fn(async (agentId: string) => ({
        runtime: agentId === "agent-a" ? runtimeA : runtimeB,
        generation: 0,
        release: vi.fn(),
      })),
    } as unknown as RuntimeSupervisor;
    const sessionMetadata = createSessionMetadataStore(createSessionRepository(database));
    registerSetupRoutes(app, { paths, identityRepository: identities });
    registerAuthRoutes(app, { authService });
    registerSessionRoutes(app, {
      authService,
      runtimeSupervisor,
      sessionMetadata,
      sessionBulk: createSessionBulkDouble(async (sessionId) => {
        const agentId = await sessionMetadata.getAgentId(sessionId);
        const lease = await runtimeSupervisor.acquire(agentId!);
        try {
          await lease.runtime.deleteSession(sessionId);
        } finally {
          lease.release();
        }
      }),
    });
    registerChatRoutes(app, { authService, runtimeSupervisor, sessionMetadata });
    await app.ready();
    const authCookie = await initializeAndLogin(app);
    await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie: authCookie },
      payload: { agentId: "agent-a" },
    });

    const sent = await app.inject({
      method: "POST",
      url: "/api/sessions/session-a/messages",
      headers: { cookie: authCookie },
      payload: { text: "归属校验", agentId: "agent-b" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/sessions/session-a",
      headers: { cookie: authCookie },
    });

    expect(sent.statusCode).toBe(202);
    expect(deleted.statusCode).toBe(204);
    expect(runtimeA.startPrompt).toHaveBeenCalledWith("session-a", "归属校验", "归属校验");
    expect(runtimeA.deleteSession).toHaveBeenCalledWith("session-a");
    expect(runtimeB.openSession).not.toHaveBeenCalled();
  });

  it("流式生成期间返回 busy，并允许通过独立请求终止", async () => {
    const { app, runtime } = await createTestApp();
    const authCookie = await initializeAndLogin(app);
    await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: authCookie } });

    const firstPrompt = app.inject({
      method: "POST",
      url: "/api/sessions/session-1/messages",
      headers: { cookie: authCookie },
      payload: { text: "执行长任务" },
    });
    await vi.waitFor(() => expect(runtime.startPrompt).toHaveBeenCalledOnce());

    const started = await firstPrompt;
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ runId: "run-1", sessionId: "session-1", status: "running" });

    const busy = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/messages",
      headers: { cookie: authCookie },
      payload: { text: "并发请求" },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "SESSION_BUSY" } });

    const aborted = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/abort",
      headers: { cookie: authCookie },
    });
    expect(aborted.statusCode).toBe(204);
  });

  it("SSE 连接立即收到会话 snapshot", async () => {
    const { app } = await createTestApp();
    const authCookie = await initializeAndLogin(app);
    await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: authCookie } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await fetch(`${address}/api/sessions/session-1/events`, {
      headers: { cookie: authCookie },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const firstChunk = await reader.read();
    const text = new TextDecoder().decode(firstChunk.value);
    await reader.cancel();

    expect(text).toContain("event: snapshot");
    expect(text).toContain("id: 0");
    expect(text).toContain('"sessionId":"session-1"');
  });

  it("SSE 将 query 恢复游标传给 runtime", async () => {
    const { app, runtime } = await createTestApp();
    const authCookie = await initializeAndLogin(app);
    await app.inject({ method: "POST", url: "/api/sessions", headers: { cookie: authCookie } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });

    const response = await fetch(`${address}/api/sessions/session-1/events?after=7`, {
      headers: { cookie: authCookie, "Last-Event-ID": "6" },
    });
    await response.body!.cancel();

    expect(runtime.lastAfterEventId).toBe(7);
  });

  it("校验相对路径并向 pi 注入统一引用协议", async () => {
    const workspaceFile: WorkspaceFileInfo = {
      path: "attachments/示例.png",
      name: "示例.png",
      mediaType: "image/png",
      size: 128,
      modifiedAt: "2026-08-05T08:00:00.000Z",
      absolutePath: "/data/workspace/attachments/示例.png",
    };
    const workspaceFiles: WorkspaceFileService = {
      saveUpload: vi.fn(),
      resolve: vi.fn(async (_agentId, path) => path === workspaceFile.path ? workspaceFile : undefined),
      remove: vi.fn(),
    };
    const runtime = new FakeRuntime();
    runtime.prompt.mockImplementation(async () => undefined);
    const { app } = await createTestApp(runtime, workspaceFiles);
    const authCookie = await initializeAndLogin(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/messages",
      headers: { cookie: authCookie },
      payload: { text: "分析这张图片", agentId: "default", filePaths: ["attachments/示例.png"] },
    });

    expect(response.statusCode).toBe(202);
    const prompt = runtime.prompt.mock.calls[0][1];
    expect(prompt).toContain("分析这张图片");
    expect(prompt).toContain('<agent_references version="1" type="file" path="attachments/示例.png" kind="file"/>');
    expect(prompt).not.toContain("/data/workspace");

    const missing = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/messages",
      headers: { cookie: authCookie },
      payload: { text: "读取", agentId: "default", filePaths: ["missing.txt"] },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "INVALID_ATTACHMENT" } });
  });

  it("重新授权引用并忽略客户端伪造的展示名称", async () => {
    const resolver: AgentReferenceResolver = {
      resolve: vi.fn(async () => [{ type: "knowledge", id: "kb-1", name: "真实产品资料" }]),
    };
    const runtime = new FakeRuntime();
    runtime.prompt.mockImplementation(async () => undefined);
    const { app } = await createTestApp(runtime, undefined, resolver);
    const authCookie = await initializeAndLogin(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/messages",
      headers: { cookie: authCookie },
      payload: { text: "请分析", references: [{ type: "knowledge", id: "kb-1", name: "伪造名称" }] },
    });

    expect(response.statusCode).toBe(202);
    expect(resolver.resolve).toHaveBeenCalledWith("default", [{ type: "knowledge", id: "kb-1" }]);
    expect(runtime.prompt).toHaveBeenCalledWith("session-1", '请分析\n\n<agent_references version="1" type="knowledge" id="kb-1" name="真实产品资料"/>');
  });

  it("拒绝未知 Pi 斜杠命令且不会启动提示词", async () => {
    const runtime = new FakeRuntime();
    runtime.listCommands.mockResolvedValue([{ name: "review", description: "审阅当前改动", source: "extension" }]);
    const { app } = await createTestApp(runtime);
    const authCookie = await initializeAndLogin(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/messages",
      headers: { cookie: authCookie },
      payload: { text: "/settings" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "UNKNOWN_COMMAND" } });
    expect(runtime.startPrompt).not.toHaveBeenCalled();
  });
});
