import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EmbeddingConfigService } from "./embedding-config-service";

describe("知识检索 Embedding 配置服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(): Promise<EmbeddingConfigService> {
    const root = await mkdtemp(join(tmpdir(), "embedding-config-"));
    roots.push(root);
    return new EmbeddingConfigService(join(root, "embedding.json"));
  }

  it("首次读取使用受管中文 Embedding 默认配置", async () => {
    const service = await fixture();

    await expect(service.read()).resolves.toMatchObject({
      config: {
        baseUrl: "http://bug-paw-embedding:80/v1",
        model: "BAAI/bge-small-zh-v1.5",
        batchSize: 8,
        hasApiKey: false,
        isManaged: true,
        enabled: true,
      },
    });
  });

  it("核心部署首次读取时禁用不可用的托管 Embedding", async () => {
    const root = await mkdtemp(join(tmpdir(), "embedding-config-core-"));
    roots.push(root);
    const service = new EmbeddingConfigService(join(root, "embedding.json"), { managedAvailable: false });

    await expect(service.read()).resolves.toMatchObject({
      config: {
        baseUrl: "http://bug-paw-embedding:80/v1",
        isManaged: true,
        enabled: false,
      },
    });
    await expect(service.getPrivate()).resolves.toMatchObject({ isManaged: true, enabled: false });
  });

  it("受管配置可在无需 API Key 的情况下保存语义检索开关", async () => {
    const service = await fixture();
    const initial = await service.read();

    const saved = await service.update({
      baseUrl: "http://bug-paw-embedding:80/v1",
      model: "BAAI/bge-small-zh-v1.5",
      batchSize: 8,
      apiKey: "",
      enabled: false,
    }, initial.revision);

    expect(saved.config).toMatchObject({ isManaged: true, hasApiKey: false, enabled: false });
    await expect(service.getPrivate()).resolves.toMatchObject({ isManaged: true, enabled: false });
  });

  it("保存单一配置后读取脱敏摘要", async () => {
    const service = await fixture();
    const initial = await service.read();

    const saved = await service.update({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-small",
      batchSize: 16,
      apiKey: randomUUID(),
      enabled: false,
    }, initial.revision);

    expect(saved.config).toEqual({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-small",
      batchSize: 16,
      hasApiKey: true,
      isManaged: false,
      enabled: false,
    });
    expect(saved.config).not.toHaveProperty("apiKey");
    expect(saved.config).toMatchObject({ isManaged: false });
  });

  it("空密钥更新保留现有密钥并校验批量大小", async () => {
    const service = await fixture();
    const initial = await service.read();
    const saved = await service.update({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-small",
      batchSize: 8,
      apiKey: randomUUID(),
      enabled: true,
    }, initial.revision);

    const retained = await service.update({
      baseUrl: "https://embed.example/v1/",
      model: "text-embedding-3-large",
      batchSize: 32,
      apiKey: "",
      enabled: true,
    }, saved.revision);

    expect(retained.config).toMatchObject({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-large",
      batchSize: 32,
      hasApiKey: true,
    });
    await expect(service.update({
      baseUrl: "https://embed.example/v1",
      model: "text-embedding-3-small",
      batchSize: 0,
      apiKey: "",
      enabled: true,
    }, retained.revision)).rejects.toThrow("批量大小必须在 1 到 128 之间");
  });
});
