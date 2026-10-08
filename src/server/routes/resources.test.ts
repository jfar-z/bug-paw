// @vitest-environment node
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store";
import { createDataPaths } from "../paths";
import { ResourceTaskManager } from "../resources/resource-service";
import type { AuthService } from "./auth";
import { registerResourceRoutes } from "./resources";

describe("资源路由", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

it("全局资源安装成功后只落盘，等待用户手动刷新 Pi 配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-refresh-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const agents = new AgentStore(paths);
    await agents.createDefault();
    const tasks = new ResourceTaskManager();
    const refreshAll = vi.fn(async () => undefined);
    const app = Fastify();
    await app.register(cookie);
    const authService = { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService;
    const dependencies = {
      authService,
      paths,
      agents,
      tasks,
      refreshAll,
      installAction: () => async () => undefined,
    };
    registerResourceRoutes(app, dependencies);

    const response = await app.inject({
      method: "POST",
      url: "/api/resources/install",
      payload: { source: "npm:demo", scope: "global", confirmed: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(response.statusCode).toBe(202);
    expect(tasks.history(response.json().taskId)?.at(-1)?.type).toBe("completed");
    expect(refreshAll).not.toHaveBeenCalled();
    await app.close();
  });
  it("任务查询只读返回终态，失效日志明确无法确认", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-task-")); roots.push(root);
    const paths = await createDataPaths(root), agents = new AgentStore(paths), tasks = new ResourceTaskManager();
    const app = Fastify(); await app.register(cookie);
    registerResourceRoutes(app, { authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService, paths, agents, tasks });
    const id = tasks.start("示例任务", async () => undefined);
    await tasks.stopAndDrain();
    expect((await app.inject({ method: "GET", url: `/api/configuration/tasks/${id}` })).json()).toEqual({ status: "completed" });
    const missing = await app.inject({ method: "GET", url: "/api/configuration/tasks/missing" });
    expect(missing.statusCode).toBe(404); expect(missing.json().error).toMatchObject({ code: "TASK_NOT_FOUND", message: expect.stringContaining("无法确认") });
    await app.close();
  });

  it("Agent 复用全局包目录的过滤引用也阻止全局卸载", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-reference-")); roots.push(root);
    const paths = await createDataPaths(root), agents = new AgentStore(paths), tasks = new ResourceTaskManager();
    const agent = await agents.createDefault();
    const installed = join(paths.piDir, "npm", "node_modules", "example-package");
    await mkdir(installed, { recursive: true });
    await mkdir(join(agent.profile.cwd, ".pi"), { recursive: true });
    await writeFile(join(paths.piDir, "settings.json"), JSON.stringify({ packages: ["npm:example-package"] }), "utf8");
    await writeFile(join(agent.profile.cwd, ".pi", "settings.json"), JSON.stringify({ packages: [{ source: installed, prompts: ["**/*", "-prompts/demo.md"] }] }), "utf8");
    const remove = vi.fn(async () => undefined);
    const app = Fastify(); await app.register(cookie);
    registerResourceRoutes(app, { authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService, paths, agents, tasks, removeAction: () => remove });
    const response = await app.inject({ method: "POST", url: "/api/resources/remove", payload: { confirmed: true, scope: "global", source: "npm:example-package" } });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe("PACKAGE_IN_USE"); expect(remove).not.toHaveBeenCalled();
    await app.close();
  });

});
