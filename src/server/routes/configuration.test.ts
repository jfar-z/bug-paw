// @vitest-environment node

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store";
import { createDataPaths } from "../paths";
import type { AuthService } from "./auth";
import { registerConfigurationRoutes } from "./configuration";
import { RuntimeRefreshError } from "../runtime-coordinator";

describe("Pi 设置路由", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-settings-routes-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    await writeFile(join(paths.piDir, "settings.json"), JSON.stringify({ defaultProvider: "global", retry: { provider: { timeoutMs: 1000 } }, piFutureField: "keep" }), "utf8");
    const agents = new AgentStore(paths);
    await agents.createDefault();
    const created = await agents.create({ name: "局部 Agent" });
    await mkdir(join(created.profile.cwd, ".pi"), { recursive: true });
    await writeFile(join(created.profile.cwd, ".pi", "settings.json"), JSON.stringify({ retry: { maxRetries: 2 } }), "utf8");
    const authService = { login: vi.fn(), logout: vi.fn(), isAuthenticated: vi.fn(async () => true) } as unknown as AuthService;
    const refreshAgent = vi.fn(async () => undefined);
    const refreshAll = vi.fn(async () => undefined);
    const refreshModels = vi.fn(async () => undefined);
    const refreshRuntime = vi.fn(async () => ({ abortedSessions: 0 }));
    const app = Fastify();
    await app.register(cookie);
    const dependencies = { authService, paths, agents, refreshAgent, refreshAll, refreshModels, refreshRuntime };
    registerConfigurationRoutes(app, dependencies);
    return { app, paths, created, refreshAgent, refreshAll, refreshModels, refreshRuntime };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("读取全局设置与 Agent 深度合并后的有效值", async () => {
    const { app, created } = await fixture();
    const global = await app.inject({ method: "GET", url: "/api/configuration/global" });
    const agent = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/settings` });
    expect(global.statusCode).toBe(200);
    expect(global.json().own.defaultProvider).toBe("global");
    expect(agent.json()).toMatchObject({ own: { retry: { maxRetries: 2 } }, inherited: { retry: { provider: { timeoutMs: 1000 } } }, effective: { retry: { maxRetries: 2, provider: { timeoutMs: 1000 } } } });
    await app.close();
  });

  it("使用点路径恢复继承并保留 Web 未知的 Pi 字段", async () => {
    const { app, paths, created } = await fixture();
    const loaded = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/settings` });
    const restored = await app.inject({ method: "PATCH", url: `/api/agents/${created.profile.id}/settings`, payload: { revision: loaded.json().revision, set: {}, inherit: ["retry.maxRetries"] } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().own.retry).toBeUndefined();
    const globalLoaded = await app.inject({ method: "GET", url: "/api/configuration/global" });
    await app.inject({ method: "PATCH", url: "/api/configuration/global", payload: { revision: globalLoaded.json().revision, set: { hideThinkingBlock: true }, inherit: [] } });
    expect(JSON.parse(await readFile(join(paths.piDir, "settings.json"), "utf8")).piFutureField).toBe("keep");
    await app.close();
  });

  it("拒绝 Agent 修改全局专属字段、未知 Web 字段和越界数值", async () => {
    const { app, created } = await fixture();
    const loaded = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/settings` });
    const cases = [
      { set: { httpProxy: "http://proxy" }, code: "GLOBAL_ONLY_SETTING" },
      { set: { unknownWebField: true }, code: "UNKNOWN_SETTING" },
      { set: { retry: { maxRetries: 999 } }, code: "SETTING_OUT_OF_RANGE" },
    ];
    for (const item of cases) {
      const response = await app.inject({ method: "PATCH", url: `/api/agents/${created.profile.id}/settings`, payload: { revision: loaded.json().revision, set: item.set, inherit: [] } });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe(item.code);
    }
    await app.close();
  });

  it("导入模型配置后只落盘，等待用户手动刷新 Pi 配置", async () => {
    const { app, refreshAll, refreshModels } = await fixture();
    const preview = await app.inject({
      method: "POST",
      url: "/api/configuration/import/preview",
      payload: { providers: {} },
    });

    expect(preview.statusCode).toBe(200);
    const applied = await app.inject({
      method: "POST",
      url: "/api/configuration/import/apply",
      payload: { confirmed: true, previewId: preview.json().previewId },
    });

    expect(applied.statusCode).toBe(200);
    expect(refreshModels).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
    await app.close();
  });

  it("认证用户可刷新 Pi Runtime 并获得中断会话数量", async () => {
    const { app, refreshRuntime } = await fixture();
    refreshRuntime.mockResolvedValueOnce({ abortedSessions: 2 });

    const response = await app.inject({ method: "POST", url: "/api/configuration/refresh-runtime" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ abortedSessions: 2 });
    expect(refreshRuntime).toHaveBeenCalledOnce();
    await app.close();
  });

  it("刷新进行中时返回稳定冲突错误", async () => {
    const { app, refreshRuntime } = await fixture();
    refreshRuntime.mockRejectedValueOnce(new RuntimeRefreshError("REFRESH_IN_PROGRESS", "Pi 配置刷新正在进行"));

    const response = await app.inject({ method: "POST", url: "/api/configuration/refresh-runtime" });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("REFRESH_IN_PROGRESS");
    await app.close();
  });
});
