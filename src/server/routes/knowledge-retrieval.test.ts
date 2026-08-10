// @vitest-environment node

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApiV1Namespace } from "../http/api-versioning";
import { EmbeddingConfigService } from "../knowledge-base/embedding-config-service";
import { registerKnowledgeRetrievalRoutes } from "./knowledge-retrieval";
import type { AuthService } from "./auth";

describe("知识检索配置路由", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("保存单一 Embedding 配置并返回脱敏摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-retrieval-routes-")); roots.push(root);
    const app = Fastify(); registerApiV1Namespace(app);
    registerKnowledgeRetrievalRoutes(app, { authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService, configs: new EmbeddingConfigService(join(root, "embedding.json")), rebuildAll: vi.fn(async () => ({ totalBases: 0, rebuiltBases: 0, failedBases: [] })) });
    await app.ready();
    const initial = await app.inject({ method: "GET", url: "/api/v1/capabilities/knowledge-retrieval" });
    const saved = await app.inject({ method: "PATCH", url: "/api/v1/capabilities/knowledge-retrieval", payload: { revision: initial.json().revision, config: { baseUrl: "https://embed.example/v1", model: "text-embedding-3-small", batchSize: 16, apiKey: randomUUID(), enabled: false } } });
    expect(saved.statusCode).toBe(200); expect(saved.json().config).toMatchObject({ hasApiKey: true, enabled: false }); expect(saved.json().config).not.toHaveProperty("apiKey");
    await app.close();
  });

  it("使用受管默认模型重建语义索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-retrieval-routes-")); roots.push(root);
    const rebuildAll = vi.fn(async () => ({ totalBases: 0, rebuiltBases: 0, failedBases: [] }));
    const app = Fastify(); registerApiV1Namespace(app);
    registerKnowledgeRetrievalRoutes(app, { authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService, configs: new EmbeddingConfigService(join(root, "embedding.json")), rebuildAll });
    await app.ready();

    const rebuilt = await app.inject({ method: "POST", url: "/api/v1/capabilities/knowledge-retrieval/rebuild" });

    expect(rebuilt.statusCode).toBe(200);
    expect(rebuildAll).toHaveBeenCalledOnce();
    await app.close();
  });

  it("关闭语义检索后拒绝重建向量索引", async () => {
    const root = await mkdtemp(join(tmpdir(), "knowledge-retrieval-routes-")); roots.push(root);
    const rebuildAll = vi.fn(async () => ({ totalBases: 0, rebuiltBases: 0, failedBases: [] }));
    const configs = new EmbeddingConfigService(join(root, "embedding.json"));
    const app = Fastify(); registerApiV1Namespace(app);
    registerKnowledgeRetrievalRoutes(app, { authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService, configs, rebuildAll });
    await app.ready();
    const initial = await configs.read();
    await configs.update({ baseUrl: "https://embed.example/v1", model: "text-embedding-3-small", batchSize: 8, apiKey: randomUUID(), enabled: false }, initial.revision);

    const rebuilt = await app.inject({ method: "POST", url: "/api/v1/capabilities/knowledge-retrieval/rebuild" });

    expect(rebuilt.statusCode).toBe(409);
    expect(rebuildAll).not.toHaveBeenCalled();
    await app.close();
  });
});
