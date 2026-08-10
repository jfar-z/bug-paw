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
  it("返回真实目录并要求安装确认，失败日志保持脱敏", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-routes-")); roots.push(root); const paths = await createDataPaths(root);
    await mkdir(join(paths.piDir, "skills", "demo"), { recursive: true }); await writeFile(join(paths.piDir, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: 示例\n---\n内容\n", "utf8");
    const agents = new AgentStore(paths); await agents.createDefault(); const tasks = new ResourceTaskManager();
    const app = Fastify(); await app.register(cookie); const authService = { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService;
    registerResourceRoutes(app, { authService, paths, agents, tasks, installAction: () => async (log) => { log("api_key=very-secret-value"); throw new Error("安装失败"); } });
    const list = await app.inject({ method: "GET", url: "/api/resources" }); expect(list.statusCode).toBe(200); expect(list.json().resources[0]).toMatchObject({ name: "demo", scope: "global" });
    const rejected = await app.inject({ method: "POST", url: "/api/resources/install", payload: { source: "npm:demo" } }); expect(rejected.statusCode).toBe(400);
    const started = await app.inject({ method: "POST", url: "/api/resources/install", payload: { source: "npm:demo", scope: "global", confirmed: true } }); expect(started.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0)); expect(JSON.stringify(tasks.history(started.json().taskId))).not.toContain("very-secret-value"); expect(tasks.history(started.json().taskId)?.at(-1)?.type).toBe("failed");
    await app.close();
  });

  it("全局包仍被 Agent 项目引用时阻止卸载", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resource-remove-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const agents = new AgentStore(paths);
    const agent = await agents.create({ name: "引用资源的 Agent" });
    await mkdir(join(agent.profile.cwd, ".pi"), { recursive: true });
    await writeFile(
      join(agent.profile.cwd, ".pi", "settings.json"),
      JSON.stringify({ packages: ["npm:shared-resource"] }),
      "utf8",
    );
    const removeAction = vi.fn(() => async () => undefined);
    const app = Fastify();
    await app.register(cookie);
    const authService = { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService;
    registerResourceRoutes(app, {
      authService,
      paths,
      agents,
      tasks: new ResourceTaskManager(),
      removeAction,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/resources/remove",
      payload: { source: "npm:shared-resource", scope: "global", confirmed: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "PACKAGE_IN_USE" } });
    expect(removeAction).not.toHaveBeenCalled();
    await app.close();
  });

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
});
