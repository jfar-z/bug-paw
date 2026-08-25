import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_AUTOMATION_CONFIG } from "../../shared/browser-automation-contracts";
import { registerBrowserAutomationRoutes } from "./browser-automation";

/** 浏览器配置 API 需要登录、乐观锁和 no-store。 */
describe("浏览器配置路由", () => {

it("读取与保存完整配置并返回部署状态", async () => {
    const app = fixture(true);
    const read = await app.inject({ method: "GET", url: "/api/capabilities/browser" });
    expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json()).toMatchObject({ revision: "r1", deployment: { available: true, activeContexts: 0 } });
    const update = await app.inject({ method: "PATCH", url: "/api/capabilities/browser", payload: { revision: "r1", config: { ...DEFAULT_BROWSER_AUTOMATION_CONFIG, enabled: true } } });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ revision: "r2", config: { enabled: true } });
    await app.close();
  });

});

function fixture(authenticated: boolean) {
  const app = Fastify();
  let document = { revision: "r1", config: structuredClone(DEFAULT_BROWSER_AUTOMATION_CONFIG) };
  registerBrowserAutomationRoutes(app, {
    authService: { isAuthenticated: vi.fn(async () => authenticated) } as never,
    configs: {
      read: vi.fn(async () => document),
      update: vi.fn(async (config, revision) => {
        if (revision !== document.revision) throw Object.assign(new Error("配置已更新"), { name: "VersionConflictError" });
        document = { revision: "r2", config };
        return document;
      }),
    },
    deploymentAvailable: true,
    status: vi.fn(async () => ({ workerAvailable: true, chromiumReady: true, activeContexts: 0, queuedRequests: 0 })),
    test: vi.fn(async () => ({ ok: true, message: "浏览器组件可用" })),
    audit: { list: vi.fn(() => []) },
    onConfigUpdated: vi.fn(async () => undefined),
  });
  return app;
}
