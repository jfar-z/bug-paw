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
});
