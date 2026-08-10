// @vitest-environment node

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { registerApiV1Namespace } from "../http/api-versioning";
import { WebResearchConfigService } from "../web-research/web-research-config-service";
import { EgressProfileRegistry } from "../web-research/egress-profile-registry";
import type { WebResearchService } from "../web-research/web-research-service";
import type { AuthService } from "./auth";
import { registerWebResearchRoutes } from "./web-research";

describe("联网搜索配置路由", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("在版本化接口下读取、保存并测试受管搜索服务", async () => {
    const { app, refreshRuntime, testConnection } = await fixture();

    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().config).toMatchObject({ enabled: false, maxResults: 5 });
    expect(loaded.headers["cache-control"]).toBe("no-store");

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/v1/capabilities/web-research",
      payload: { revision: loaded.json().revision, config: { ...DEFAULT_WEB_RESEARCH_CONFIG, enabled: true, maxResults: 8 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toMatchObject({ enabled: true, maxResults: 8 });
    expect(refreshRuntime).toHaveBeenCalledOnce();

    const connection = await app.inject({ method: "POST", url: "/api/v1/capabilities/web-research/test" });
    expect(connection.json()).toEqual({ ok: true, message: "SearXNG 服务连接正常" });
    expect(testConnection).toHaveBeenCalledOnce();

    await app.close();
  });

  it("拒绝未认证访问与无效资源上限", async () => {
    const { app, authService } = await fixture(false);

    expect((await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" })).statusCode).toBe(401);
    vi.mocked(authService.isAuthenticated).mockImplementation(async () => true);
    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/capabilities/web-research",
      payload: { revision: loaded.json().revision, config: { ...DEFAULT_WEB_RESEARCH_CONFIG, maxResults: 99 } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_FAILED");

    await app.close();
  });

  async function fixture(authenticated = true) {
    const root = await mkdtemp(join(tmpdir(), "web-research-routes-"));
    roots.push(root);
    const app = Fastify();
    const authService = { isAuthenticated: vi.fn(async () => authenticated) } as unknown as AuthService;
    const configs = new WebResearchConfigService(join(root, "web-research.json"));
    const testConnection = vi.fn(async () => undefined);
    const refreshRuntime = vi.fn(async () => undefined);
    registerApiV1Namespace(app);
    registerWebResearchRoutes(app, {
      authService,
      configs,
      service: { testConnection } as unknown as WebResearchService,
      egressProfiles: new EgressProfileRegistry(),
      refreshRuntime,
    });
    await app.ready();
    return { app, authService, refreshRuntime, testConnection };
  }
});
