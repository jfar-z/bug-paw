// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ModelConfigService, ProviderAlreadyExistsError } from "./model-config-service";

describe("ModelConfigService", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-model-config-"));
    roots.push(root);
    return {
      root,
      modelsPath: join(root, "models.json"),
      authPath: join(root, "auth.json"),
    };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("无效 Provider Schema 返回字段诊断且不覆盖正式文件", async () => {
    const files = await fixture();
    await writeFile(files.modelsPath, '{"providers":{"example":{"models":[]}}}\n', "utf8");
    const service = new ModelConfigService(files);
    const loaded = await service.read();

    await expect(
      service.updateProvider("example", { models: [{ id: "" }] }, loaded.revision),
    ).rejects.toMatchObject({
      name: "ModelConfigurationValidationError",
      diagnostics: expect.arrayContaining([expect.objectContaining({ source: "models", severity: "error" })]),
    });
    expect(await readFile(files.modelsPath, "utf8")).toBe('{"providers":{"example":{"models":[]}}}\n');
  });

  it("目标节点变更时保留合法未知 Pi 字段和其他 Provider", async () => {
    const files = await fixture();
    await writeFile(
      files.modelsPath,
      '{"providers":{"example":{"name":"Old","authHeader":true,"compat":{"supportsStore":false}},"other":{"baseUrl":"http://localhost:11434"}}}\n',
      "utf8",
    );
    const service = new ModelConfigService(files);
    const loaded = await service.read();

    await service.updateProvider("example", { name: "New" }, loaded.revision);

    expect(JSON.parse(await readFile(files.modelsPath, "utf8"))).toEqual({
      providers: {
        example: { name: "New", authHeader: true, compat: { supportsStore: false } },
        other: { baseUrl: "http://localhost:11434" },
      },
    });
  });

  it("创建 Provider 时拒绝覆盖既有 ID", async () => {
    const files = await fixture();
    await writeFile(files.modelsPath, '{"providers":{"example":{"name":"Existing"}}}\n', "utf8");
    const service = new ModelConfigService(files);
    const loaded = await service.read();

    await expect(service.createProvider("example", { name: "Replacement" }, loaded.revision)).rejects.toBeInstanceOf(ProviderAlreadyExistsError);
  });

  it("重排 Provider 与模型时保留 Pi 原生 JSON 顺序", async () => {
    const files = await fixture();
    await writeFile(
      files.modelsPath,
      '{"providers":{"first":{"baseUrl":"http://localhost:11434","api":"openai-completions","models":[{"id":"one"},{"id":"two"}]},"second":{"baseUrl":"http://localhost:11434","api":"openai-completions","models":[{"id":"three"},{"id":"four"}]}}}\n',
      "utf8",
    );
    const service = new ModelConfigService(files);
    const providers = await service.reorderProviders(["second", "first"], (await service.read()).revision);
    const models = await service.reorderModels("second", ["four", "three"], providers.revision);

    const saved = JSON.parse(await readFile(files.modelsPath, "utf8"));
    expect(Object.keys(saved.providers)).toEqual(["second", "first"]);
    expect(saved.providers.second.models.map((model: { id: string }) => model.id)).toEqual(["four", "three"]);
    expect(models.value).toEqual(saved);
  });
});
