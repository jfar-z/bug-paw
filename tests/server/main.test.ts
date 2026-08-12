import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildServer, resolveAgentSessionDir } from "../../src/server/main";
import { createDataPaths } from "../../src/server/paths";
import type { ChatEvent, PiRuntimeGateway } from "../../src/server/pi-runtime";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-main-"));
  temporaryDirectories.push(root);
  const staticRoot = join(root, "web");
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, "index.html"), "<!doctype html><title>pi agent</title>", "utf8");
  await writeFile(join(staticRoot, "asset.js"), "export {};", "utf8");
  await writeFile(join(staticRoot, "sw.js"), "self.addEventListener('fetch', () => undefined);", "utf8");
  return { root, staticRoot };
}

function createRuntimeFixture(): PiRuntimeGateway {
  return {
    listModels: async () => [],
    listCommands: async () => [],
    listSessions: async () => [],
    createSession: async () => ({ id: "session-after-setup", messages: [], lastEventId: 0 }),
    openSession: async (sessionId) => ({ id: sessionId, messages: [], lastEventId: 0 }),
    startPrompt: async (sessionId) => ({
      runId: "run-after-setup",
      sessionId,
      status: "running",
      startedAt: "2026-08-07T00:00:00.000Z",
    }),
    prompt: async () => undefined,
    abort: async () => undefined,
    abortAll: async () => 0,
    setModel: async () => undefined,
    renameSession: async () => undefined,
    archiveSession: async () => undefined,
    unarchiveSession: async () => undefined,
    deleteSession: async () => undefined,
    subscribe: (_sessionId, _cursor, _listener?: (event: ChatEvent) => void) => () => undefined,
    dispose: vi.fn(),
  };
}

describe("Web 服务装配", () => {
  it("历史 default Agent 继续从旧会话目录读取，普通 Agent 使用隔离目录", async () => {
    const fixture = await createFixture();
    const paths = await createDataPaths(join(fixture.root, "data"));

    expect(resolveAgentSessionDir(paths, "default")).toBe(join(paths.piDir, "sessions", "default"));
    expect(resolveAgentSessionDir(paths, "research")).toBe(join(paths.piDir, "sessions", "research"));
  });

  it("创建运行检查点目录和应用数据库路径", async () => {
    const fixture = await createFixture();
    const paths = await createDataPaths(join(fixture.root, "data"));

    await expect(access(paths.runDir)).resolves.toBeUndefined();
    expect(paths.databaseFile).toBe(join(fixture.root, "data", "app", "bugpaw.sqlite3"));
  });

  it("提供健康检查", async () => {
    const fixture = await createFixture();
    const app = await buildServer({ dataRoot: join(fixture.root, "data"), staticRoot: fixture.staticRoot });

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("提供静态资源并将前端路由回退到应用壳", async () => {
    const fixture = await createFixture();
    const app = await buildServer({ dataRoot: join(fixture.root, "data"), staticRoot: fixture.staticRoot });

    const asset = await app.inject({ method: "GET", url: "/asset.js" });
    const fallback = await app.inject({ method: "GET", url: "/sessions/example" });

    expect(asset.body).toBe("export {};");
    expect(fallback.body).toContain("<title>pi agent</title>");
    expect(fallback.headers["cache-control"]).toBe("no-cache");
    await app.close();
  });

  it("service worker 不使用静态资源的长缓存，确保已安装应用及时更新", async () => {
    const fixture = await createFixture();
    const app = await buildServer({ dataRoot: join(fixture.root, "data"), staticRoot: fixture.staticRoot });

    const worker = await app.inject({ method: "GET", url: "/sw.js" });

    expect(worker.statusCode).toBe(200);
    expect(worker.headers["cache-control"]).toBe("no-cache");
    await app.close();
  });

  it("未知 API 不会回退到 HTML", async () => {
    const fixture = await createFixture();
    const app = await buildServer({ dataRoot: join(fixture.root, "data"), staticRoot: fixture.staticRoot });

    const response = await app.inject({ method: "GET", url: "/api/unknown" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        requestId: expect.any(String),
      },
    });
    await app.close();
  });

  it("仅通过 /api/v1 暴露业务接口", async () => {
    const fixture = await createFixture();
    const app = await buildServer({ dataRoot: join(fixture.root, "data"), staticRoot: fixture.staticRoot });

    const current = await app.inject({ method: "GET", url: "/api/v1/status" });
    const legacy = await app.inject({ method: "GET", url: "/api/status" });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ initialized: false, authenticated: false });
    expect(legacy.statusCode).toBe(404);
    expect(legacy.json()).toMatchObject({
      error: {
        code: "NOT_FOUND",
        requestId: expect.any(String),
      },
    });
    await app.close();
  });

  it("未初始化启动后可在同一进程完成配置并创建 Agent 会话", async () => {
    const fixture = await createFixture();
    const runtime = createRuntimeFixture();
    const runtimeFactory = vi.fn(async () => runtime);
    const app = await buildServer({
      dataRoot: join(fixture.root, "data"),
      staticRoot: fixture.staticRoot,
      runtimeFactory,
    });

    const setup = await app.inject({
      method: "POST",
      url: "/api/v1/setup",
      payload: {
        password: "local-password-123",
        confirmPassword: "local-password-123",
        provider: { type: "test", apiKey: "test-key-not-secret", defaultModel: "model-1" },
      },
    });
    expect(setup.statusCode).toBe(201);
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/login",
      payload: { password: "local-password-123", remember: false },
    });
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const agent = await app.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: { cookie },
      payload: { name: "首启 Agent" },
    });
    expect(agent.statusCode).toBe(201);

    const session = await app.inject({
      method: "POST",
      url: "/api/v1/sessions",
      headers: { cookie },
      payload: { agentId: agent.json().profile.id },
    });

    expect(session.statusCode).toBe(201);
    expect(session.json()).toMatchObject({ id: "session-after-setup", agentId: agent.json().profile.id });
    expect(runtimeFactory).toHaveBeenCalledOnce();
    await app.close();
  });

  it("服务关闭后可以使用同一数据目录重新启动", async () => {
    const fixture = await createFixture();
    const dataRoot = join(fixture.root, "data");
    const first = await buildServer({ dataRoot, staticRoot: fixture.staticRoot });

    await first.close();
    const restarted = await buildServer({ dataRoot, staticRoot: fixture.staticRoot });
    await restarted.close();
  });

  it("启动装配失败会释放数据目录锁", async () => {
    const fixture = await createFixture();
    const dataRoot = join(fixture.root, "data");

    await expect(buildServer({ dataRoot, staticRoot: join(fixture.root, "missing") })).rejects.toThrow();

    const app = await buildServer({ dataRoot, staticRoot: fixture.staticRoot });
    await app.close();
  });
});
