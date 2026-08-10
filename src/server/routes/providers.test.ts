// @vitest-environment node

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store";
import { CredentialService } from "../configuration/credential-service";
import { ModelConfigService } from "../configuration/model-config-service";
import { ProviderRenameService } from "../configuration/provider-rename-service";
import { ProviderModelDiscoveryError } from "../provider-model-discovery";
import { createDataPaths } from "../paths";
import { ModelConnectionTestError } from "../runtime-coordinator";
import type { AuthService } from "./auth";
import { registerProviderRoutes } from "./providers";

describe("Provider 配置路由", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-provider-routes-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const modelsPath = join(paths.piDir, "models.json");
    const authPath = join(paths.piDir, "auth.json");
    await writeFile(modelsPath, '{"providers":{"example":{"name":"Example","baseUrl":"http://localhost:11434","api":"openai-completions","models":[]}}}\n', "utf8");
    const models = new ModelConfigService({ modelsPath, authPath });
    const credentials = new CredentialService(authPath);
    const agents = new AgentStore(paths);
    await agents.createDefault();
    const authService = {
      login: vi.fn(), logout: vi.fn(), isAuthenticated: vi.fn(async () => true),
    } as unknown as AuthService;
    const refreshModels = vi.fn(async () => undefined);
    const testModels = vi.fn(async () => ({
      providerId: "example",
      results: [{ modelId: "m1", modelName: "模型一", ok: true, durationMs: 12, responsePreview: "OK" }],
    }));
    const discoverModels = vi.fn(async () => ({
      providerId: "example",
      models: [{ id: "discovered", name: "discovered", exists: false }],
    }));
    const app = Fastify();
    await app.register(cookie);
    const renameService = new ProviderRenameService({ paths, models, agents });
    const dependencies = { authService, models, credentials, agents, renameService, refreshModels, testModels, discoverModels };
    registerProviderRoutes(app, dependencies);
    return { app, paths, modelsPath, authPath, models, credentials, agents, refreshModels, testModels, discoverModels };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("API Key 只写且支持替换和删除，响应从不回显明文", async () => {
    const { app, credentials } = await fixture();
    const firstRevision = await credentials.getRevision();
    const set = await app.inject({ method: "PUT", url: "/api/providers/example/credential", payload: { revision: firstRevision, apiKey: "first-secret" } });
    expect(set.statusCode).toBe(200);
    expect(set.body).not.toContain("first-secret");
    const replaced = await app.inject({ method: "PUT", url: "/api/providers/example/credential", payload: { revision: set.json().credentialRevision, apiKey: "second-secret" } });
    expect(replaced.body).not.toContain("second-secret");
    const removed = await app.inject({ method: "DELETE", url: "/api/providers/example/credential", payload: { revision: replaced.json().credentialRevision } });
    expect(removed.statusCode).toBe(200);
    expect(await credentials.list()).toEqual([]);
    await app.close();
  });

  it("认证用户可按需读取指定 Provider 的 API Key，公开列表仍不回显", async () => {
    const { app, credentials } = await fixture();
    await credentials.setApiKey("example", "provider-secret", await credentials.getRevision());

    const shown = await app.inject({ method: "GET", url: "/api/providers/example/credential" });
    const listed = await app.inject({ method: "GET", url: "/api/providers" });

    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ apiKey: "provider-secret" });
    expect(listed.body).not.toContain("provider-secret");
    await app.close();
  });

  it("Provider 未知秘密与认证 Header 只返回占位且回写时保留原值", async () => {
    const { app, modelsPath } = await fixture();
    await writeFile(modelsPath, JSON.stringify({ providers: { example: {
      name: "Example",
      baseUrl: "https://user:password@example.test/v1?token=query-secret",
      api: "openai-completions",
      headers: { Authorization: "Bearer header-secret", "X-API-Key": "header-key" },
      nested: { password: "nested-secret" },
      models: [],
    } } }), "utf8");

    const loaded = await app.inject({ method: "GET", url: "/api/providers" });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.body).not.toMatch(/query-secret|header-secret|header-key|nested-secret|proxy-password/u);
    const publicProvider = loaded.json().value.providers.example;
    expect(publicProvider.headers).toEqual({ Authorization: "[REDACTED]", "X-API-Key": "[REDACTED]" });

    const updated = await app.inject({
      method: "PUT",
      url: "/api/providers/example",
      payload: { revision: loaded.json().revision, provider: { ...publicProvider, name: "Updated" } },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toMatch(/query-secret|header-secret|header-key|nested-secret/u);
    const persisted = JSON.parse(await readFile(modelsPath, "utf8"));
    expect(persisted.providers.example).toMatchObject({
      baseUrl: "https://user:password@example.test/v1?token=query-secret",
      headers: { Authorization: "Bearer header-secret", "X-API-Key": "header-key" },
      nested: { password: "nested-secret" },
      name: "Updated",
    });
    await app.close();
  });

  it("保存 Provider 与凭证只落盘，不自动刷新模型 Runtime", async () => {
    const { app, models, credentials, refreshModels } = await fixture();
    const updated = await app.inject({
      method: "PUT",
      url: "/api/providers/example",
      payload: { revision: (await models.read()).revision, provider: { name: "已保存" } },
    });
    expect(updated.statusCode).toBe(200);

    const credential = await app.inject({
      method: "PUT",
      url: "/api/providers/example/credential",
      payload: { revision: await credentials.getRevision(), apiKey: "secret" },
    });
    expect(credential.statusCode).toBe(200);
    expect(refreshModels).not.toHaveBeenCalled();
    await app.close();
  });

  it("过期 revision 返回 409", async () => {
    const { app, models } = await fixture();
    const loaded = await models.read();
    await models.updateProvider("example", { name: "并发修改" }, loaded.revision);
    const response = await app.inject({ method: "PUT", url: "/api/providers/example", payload: { revision: loaded.revision, provider: { name: "旧提交" } } });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it("重排 Provider 和模型时直接保存 Pi models.json 顺序", async () => {
    const { app, models } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        id: "second",
        revision: (await models.read()).revision,
        provider: { baseUrl: "http://localhost:11434", api: "openai-completions", models: [{ id: "three" }, { id: "four" }] },
      },
    });
    const reorderedProviders = await app.inject({
      method: "POST",
      url: "/api/providers/order",
      payload: { revision: created.json().revision, providerIds: ["second", "example"] },
    });
    const reorderedModels = await app.inject({
      method: "POST",
      url: "/api/providers/second/models/order",
      payload: { revision: reorderedProviders.json().revision, modelIds: ["four", "three"] },
    });

    expect(reorderedProviders.statusCode).toBe(200);
    expect(Object.keys(reorderedModels.json().value.providers)).toEqual(["second", "example"]);
    expect(reorderedModels.json().value.providers.second.models.map((model: { id: string }) => model.id)).toEqual(["four", "three"]);
    await app.close();
  });

  it("模型排序允许 Pi 合法的非 Provider 格式模型 ID", async () => {
    const { app, models } = await fixture();
    const saved = await models.updateProvider("example", {
      models: [{ id: "Qwen/Qwen3-32B" }, { id: "vendor:model" }],
    }, (await models.read()).revision);

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/example/models/order",
      payload: { revision: saved.revision, modelIds: ["vendor:model", "Qwen/Qwen3-32B"] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().value.providers.example.models.map((model: { id: string }) => model.id)).toEqual(["vendor:model", "Qwen/Qwen3-32B"]);
    await app.close();
  });

  it("创建要求用户提供 Provider ID，改名会迁移持久化引用", async () => {
    const { app, models } = await fixture();
    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: {
        id: "custom-provider",
        revision: (await models.read()).revision,
        provider: { name: "自定义 Provider", baseUrl: "http://localhost:11434", api: "openai-completions", models: [] },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().value.providers["custom-provider"].name).toBe("自定义 Provider");

    const renamed = await app.inject({
      method: "POST",
      url: "/api/providers/custom-provider/rename",
      payload: { id: "renamed-provider", revision: created.json().revision, confirmed: true },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().value.providers["renamed-provider"].name).toBe("自定义 Provider");
    await app.close();
  });

  it("拒绝删除被 Agent 默认模型引用的 Provider", async () => {
    const { app, models, agents } = await fixture();
    const loaded = await models.read();
    await agents.create({ name: "引用者", defaultModel: { provider: "example", id: "m1" } });
    const response = await app.inject({ method: "DELETE", url: "/api/providers/example", payload: { revision: loaded.revision } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PROVIDER_IN_USE");
    await app.close();
  });

  it("无效模型 Schema 返回 422 且不覆盖正式文件", async () => {
    const { app, models, modelsPath } = await fixture();
    const loaded = await models.read();
    const before = await readFile(modelsPath, "utf8");
    const response = await app.inject({ method: "PUT", url: "/api/providers/example", payload: { revision: loaded.revision, provider: { models: [{ id: "" }] } } });
    expect(response.statusCode).toBe(422);
    expect(await readFile(modelsPath, "utf8")).toBe(before);
    await app.close();
  });

  it("连接测试转交当前已保存模型且不写入配置", async () => {
    const { app, modelsPath, testModels } = await fixture();
    const before = await readFile(modelsPath, "utf8");
    const response = await app.inject({
      method: "POST",
      url: "/api/providers/example/test",
      payload: { scope: "current", modelId: "m1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providerId: "example",
      results: [{ modelId: "m1", modelName: "模型一", ok: true, durationMs: 12, responsePreview: "OK" }],
    });
    expect(testModels).toHaveBeenCalledWith("example", { scope: "current", modelId: "m1" });
    expect(await readFile(modelsPath, "utf8")).toBe(before);
    await app.close();
  });

  it("连接测试把进行中的 Provider 映射为稳定冲突错误", async () => {
    const { app, testModels } = await fixture();
    testModels.mockRejectedValueOnce(new ModelConnectionTestError("MODEL_TEST_IN_PROGRESS", "该 Provider 正在测试中"));

    const response = await app.inject({
      method: "POST",
      url: "/api/providers/example/test",
      payload: { scope: "all" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "MODEL_TEST_IN_PROGRESS" } });
    await app.close();
  });

  it("发现接口只转交路径 Provider ID，不接受浏览器注入的连接配置", async () => {
    const { app, discoverModels } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: "/api/providers/example/discover-models",
      payload: { baseUrl: "https://attacker.invalid", headers: { Authorization: "Bearer injected" }, apiKey: "injected" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      providerId: "example",
      models: [{ id: "discovered", name: "discovered", exists: false }],
    });
    expect(discoverModels).toHaveBeenCalledWith("example");
    await app.close();
  });

  it.each([
    ["PROVIDER_NOT_FOUND", 404],
    ["UNSUPPORTED_PROVIDER_API", 422],
    ["MODEL_DISCOVERY_IN_PROGRESS", 409],
  ] as const)("将 %s 映射为 %s", async (code, status) => {
    const { app, discoverModels } = await fixture();
    discoverModels.mockRejectedValueOnce(new ProviderModelDiscoveryError(code, "安全消息"));

    const response = await app.inject({ method: "POST", url: "/api/providers/example/discover-models" });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code, message: "安全消息" } });
    await app.close();
  });
});
