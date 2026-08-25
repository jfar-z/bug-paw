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

});
