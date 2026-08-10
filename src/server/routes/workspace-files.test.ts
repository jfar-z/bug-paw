// @vitest-environment node

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileManagerError, type WorkspaceFileManager } from "../workspace-files";
import { createAuthService, registerAuthRoutes } from "./auth";
import { registerSetupRoutes } from "./setup";
import { registerWorkspaceFileRoutes } from "./workspace-files";
import { createDataPaths } from "../paths";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryRoots: string[] = [];
const testApps: FastifyInstance[] = [];

describe("工作区文件管理路由", () => {
  afterEach(async () => {
    await Promise.all(testApps.splice(0).map((app) => app.close()));
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("提供浏览、搜索、文本预览和管理接口", async () => {
    const manager = fakeManager();
    const { app, cookieHeader } = await createApp(manager);

    expect((await app.inject({ method: "GET", url: "/api/agents/default/workspace/entries?directory=docs", headers: { cookie: cookieHeader } })).json()).toMatchObject({ entries: [{ path: "docs/readme.md" }] });
    expect((await app.inject({ method: "GET", url: "/api/agents/default/workspace/search?query=read", headers: { cookie: cookieHeader } })).json()).toMatchObject({ entries: [{ name: "readme.md" }] });
    expect((await app.inject({ method: "GET", url: "/api/agents/default/workspace/text?path=docs/readme.md", headers: { cookie: cookieHeader } })).json()).toMatchObject({ content: "# Readme" });
    expect((await app.inject({ method: "POST", url: "/api/agents/default/workspace/directories", headers: { cookie: cookieHeader }, payload: { directory: "", name: "drafts" } })).json()).toMatchObject({ path: "drafts", kind: "directory" });
    expect((await app.inject({ method: "PATCH", url: "/api/agents/default/workspace/entries", headers: { cookie: cookieHeader }, payload: { operation: "rename", path: "drafts", name: "notes" } })).json()).toMatchObject({ path: "notes" });
    expect((await app.inject({ method: "DELETE", url: "/api/agents/default/workspace/entries", headers: { cookie: cookieHeader }, payload: { paths: ["notes"] } })).statusCode).toBe(204);
    expect(manager.remove).toHaveBeenCalledWith("default", ["notes"]);
  });

  it("拒绝未登录请求和无效移动操作", async () => {
    const manager = fakeManager();
    const { app, cookieHeader } = await createApp(manager);

    expect((await app.inject({ method: "GET", url: "/api/agents/default/workspace/entries" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PATCH", url: "/api/agents/default/workspace/entries", headers: { cookie: cookieHeader }, payload: { operation: "move", path: "a.txt" } })).statusCode).toBe(400);
  });

  it("将移动时缺失的目标目录映射为未找到响应", async () => {
    const manager = fakeManager();
    vi.mocked(manager.move).mockRejectedValueOnce(new WorkspaceFileManagerError("NOT_FOUND", "文件或目录不存在"));
    const { app, cookieHeader } = await createApp(manager);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/agents/default/workspace/entries",
      headers: { cookie: cookieHeader },
      payload: { operation: "move", path: "a.txt", targetDirectory: "missing-directory" },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "NOT_FOUND", message: "文件或目录不存在" } });
  });

  it("将创建目录确认标志传给移动服务", async () => {
    const manager = fakeManager();
    const { app, cookieHeader } = await createApp(manager);

    const response = await app.inject({
      method: "PATCH",
      url: "/api/agents/default/workspace/entries",
      headers: { cookie: cookieHeader },
      payload: { operation: "move", path: "a.txt", targetDirectory: "drafts/review", createTargetDirectory: true },
    });

    expect(response.statusCode).toBe(200);
    expect(manager.move).toHaveBeenCalledWith("default", "a.txt", "drafts/review", true);
  });
});

async function createApp(manager: WorkspaceFileManager) {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-workspace-routes-"));
  temporaryRoots.push(root);
  const paths = await createDataPaths(root);
  const app = Fastify();
  testApps.push(app);
  await app.register(cookie);
  await app.register(multipart);
  const authService = createAuthService(paths);
  registerSetupRoutes(app, { paths });
  registerAuthRoutes(app, { authService, paths });
  registerWorkspaceFileRoutes(app, { authService, manager });
  await app.ready();
  await app.inject({ method: "POST", url: "/api/setup", payload: { password: "correct horse battery", confirmPassword: "correct horse battery", provider: { type: "openai", apiKey: "test-key", defaultModel: "test" } } });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "correct horse battery", remember: false } });
  return { app, cookieHeader: String(login.headers["set-cookie"]).split(";", 1)[0] };
}

function fakeManager(): WorkspaceFileManager {
  return {
    list: vi.fn(async () => [{ path: "docs/readme.md", name: "readme.md", kind: "file" as const, mediaType: "text/markdown", size: 8, modifiedAt: "2026-08-06T00:00:00.000Z" }]),
    search: vi.fn(async () => [{ path: "docs/readme.md", name: "readme.md", kind: "file" as const, mediaType: "text/markdown", size: 8, modifiedAt: "2026-08-06T00:00:00.000Z" }]),
    listReferences: vi.fn(async () => []),
    readText: vi.fn(async () => ({ path: "docs/readme.md", content: "# Readme", truncated: false })),
    readFile: vi.fn(async () => ({ name: "readme.md", mediaType: "text/markdown", content: Buffer.from("# Readme") })),
    saveUploads: vi.fn(async () => []),
    createDirectory: vi.fn(async () => ({ path: "drafts", name: "drafts", kind: "directory" as const, modifiedAt: "2026-08-06T00:00:00.000Z" })),
    rename: vi.fn(async () => ({ path: "notes", name: "notes", kind: "directory" as const, modifiedAt: "2026-08-06T00:00:00.000Z" })),
    move: vi.fn(async () => ({ path: "docs/a.txt", name: "a.txt", kind: "file" as const, modifiedAt: "2026-08-06T00:00:00.000Z" })),
    remove: vi.fn(async () => undefined),
  };
}
