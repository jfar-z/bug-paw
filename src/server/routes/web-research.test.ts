// @vitest-environment node

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { CredentialService } from "../configuration/credential-service";
import { ConfigTransaction } from "../configuration/config-transaction";
import { registerApiV1Namespace } from "../http/api-versioning";
import { ManagedSearchProviderRegistry } from "../web-research/managed-search-provider-registry";
import { WebResearchConfigService } from "../web-research/web-research-config-service";
import { EgressProfileRegistry } from "../web-research/egress-profile-registry";
import { WebResearchProviderManagementService } from "../web-research/web-research-provider-management-service";
import type { WebResearchService } from "../web-research/web-research-service";
import type { AuthService } from "./auth";
import { registerWebResearchRoutes } from "./web-research";

describe("联网搜索配置路由", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("独立保存全局策略并测试已持久化的受管搜索服务", async () => {
    const { app, refreshRuntime, testProvider } = await fixture();

    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().config).toMatchObject({ enabled: false, maxResults: 5 });
    expect(loaded.json().providerTemplates).toContainEqual({ id: "managed-searxng", name: "内置 SearXNG", type: "searxng", connectionMode: "managed" });
    expect(loaded.json().credentials).toEqual([]);
    expect(JSON.stringify(loaded.json())).not.toContain("bug-paw-search:8080");
    expect(loaded.headers["cache-control"]).toBe("no-store");

    const { searchProviders: _providers, ...globalConfig } = loaded.json().config;
    const saved = await app.inject({
      method: "PATCH",
      url: "/api/v1/capabilities/web-research/global",
      payload: { revision: loaded.json().revision, config: { ...globalConfig, enabled: true, maxResults: 8 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().config).toMatchObject({ enabled: true, maxResults: 8 });
    expect(refreshRuntime).toHaveBeenCalledOnce();

    const connection = await app.inject({ method: "POST", url: "/api/v1/capabilities/web-research/providers/managed-searxng/test" });
    expect(connection.json()).toEqual({ ok: true, message: "搜索服务连接正常" });
    expect(testProvider).toHaveBeenCalledWith("managed-searxng");

    await app.close();
  });

  it("原子新增和编辑搜索渠道，普通配置响应始终脱敏", async () => {
    const { app, refreshRuntime } = await fixture();
    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/web-research/providers",
      payload: {
        configRevision: loaded.json().revision,
        credentialRevision: loaded.json().credentialRevision,
        provider: { id: "bocha-main", name: "博查主线路", type: "bocha", connectionMode: "official", enabled: true, timeoutMs: 8_000, egressProfileId: "direct" },
        apiKey: "search-secret",
      },
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().config.searchProviders).toContainEqual(expect.objectContaining({ id: "bocha-main", enabled: true }));
    expect(JSON.stringify(added.json())).not.toContain("search-secret");

    const edited = await app.inject({
      method: "PATCH",
      url: "/api/v1/capabilities/web-research/providers/bocha-main",
      payload: {
        configRevision: added.json().revision,
        credentialRevision: added.json().credentialRevision,
        provider: { id: "bocha-main", name: "博查备用线路", type: "bocha", connectionMode: "official", enabled: false, timeoutMs: 9_000 },
        credential: { action: "replace", apiKey: "replacement-secret" },
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().config.searchProviders).toContainEqual(expect.objectContaining({ id: "bocha-main", name: "博查备用线路", enabled: false }));
    expect(JSON.stringify(edited.json())).not.toContain("replacement-secret");
    expect(refreshRuntime).toHaveBeenCalledTimes(2);

    const settings = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    expect(settings.json().credentials).toContainEqual({ providerId: "bocha-main", type: "api_key", configured: true });
    expect(JSON.stringify(settings.json())).not.toContain("search-secret");

    const shown = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research/providers/bocha-main/credential" });
    expect(shown.json()).toEqual({ apiKey: "replacement-secret" });
    expect(shown.headers["cache-control"]).toBe("no-store");

    expect((await app.inject({
      method: "PUT",
      url: "/api/v1/capabilities/web-research/providers/bocha-main/credential",
      payload: { revision: edited.json().credentialRevision, apiKey: "obsolete" },
    })).statusCode).toBe(404);
    await app.close();
  });

  it("按完整标识列表即时保存渠道顺序", async () => {
    const { app, refreshRuntime } = await fixture();
    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/web-research/providers",
      payload: {
        configRevision: loaded.json().revision,
        credentialRevision: loaded.json().credentialRevision,
        provider: { id: "bocha-main", name: "博查", type: "bocha", connectionMode: "official", enabled: false, timeoutMs: 8_000 },
      },
    });
    const ids = added.json().config.searchProviders.map(({ id }: { id: string }) => id).reverse();

    const reordered = await app.inject({
      method: "PUT",
      url: "/api/v1/capabilities/web-research/providers/order",
      payload: { revision: added.json().revision, providerIds: ids },
    });

    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().config.searchProviders.map(({ id }: { id: string }) => id)).toEqual(ids);
    expect(refreshRuntime).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("删除 Provider 时原子删除对应凭证并保留受管容器配置能力", async () => {
    const { app, credentials } = await fixture();
    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    const added = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/web-research/providers",
      payload: {
        configRevision: loaded.json().revision,
        credentialRevision: loaded.json().credentialRevision,
        provider: { id: "tavily-backup", name: "Tavily 备用", type: "tavily", connectionMode: "official", enabled: false, timeoutMs: 10_000 },
        apiKey: "delete-me",
      },
    });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/v1/capabilities/web-research/providers/tavily-backup",
      payload: { configRevision: added.json().revision, credentialRevision: added.json().credentialRevision },
    });

    expect(deleted.statusCode).toBe(204);
    expect(await credentials.getApiKey("tavily-backup")).toBeUndefined();
    const settings = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    expect(settings.json().config.searchProviders).not.toContainEqual(expect.objectContaining({ id: "tavily-backup" }));
    expect(settings.json().providerTemplates).toContainEqual(expect.objectContaining({ id: "managed-searxng" }));
    await app.close();
  });

  it("拒绝未认证访问与无效资源上限", async () => {
    const { app, authService } = await fixture(false);

    expect((await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" })).statusCode).toBe(401);
    vi.mocked(authService.isAuthenticated).mockImplementation(async () => true);
    const loaded = await app.inject({ method: "GET", url: "/api/v1/capabilities/web-research" });
    const { searchProviders: _providers, ...globalConfig } = loaded.json().config;
    const invalid = await app.inject({
      method: "PATCH",
      url: "/api/v1/capabilities/web-research/global",
      payload: { revision: loaded.json().revision, config: { ...globalConfig, maxResults: 99 } },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("VALIDATION_FAILED");

    const obsolete = await app.inject({
      method: "PATCH",
      url: "/api/v1/capabilities/web-research",
      payload: { revision: loaded.json().revision, config: DEFAULT_WEB_RESEARCH_CONFIG },
    });
    expect(obsolete.statusCode).toBe(404);

    await app.close();
  });

  async function fixture(authenticated = true) {
    const root = await mkdtemp(join(tmpdir(), "web-research-routes-"));
    roots.push(root);
    const app = Fastify();
    const authService = { isAuthenticated: vi.fn(async () => authenticated) } as unknown as AuthService;
    const configPath = join(root, "web-research.json");
    const authPath = join(root, "web-research-auth.json");
    const managedProviders = new ManagedSearchProviderRegistry(true);
    const configs = new WebResearchConfigService(configPath, undefined, managedProviders);
    const credentials = new CredentialService(authPath);
    const transaction = new ConfigTransaction({ rootDir: root, transactionDir: join(root, "transactions") });
    const management = new WebResearchProviderManagementService({ configs, credentials, configPath, authPath, transaction });
    const testProvider = vi.fn(async () => undefined);
    const refreshRuntime = vi.fn(async () => undefined);
    registerApiV1Namespace(app);
    registerWebResearchRoutes(app, {
      authService,
      configs,
      credentials,
      management,
      managedProviders,
      service: { testProvider } as unknown as WebResearchService,
      egressProfiles: new EgressProfileRegistry(),
      refreshRuntime,
    });
    await app.ready();
    return { app, authService, refreshRuntime, testProvider, credentials };
  }
});
