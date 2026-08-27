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
