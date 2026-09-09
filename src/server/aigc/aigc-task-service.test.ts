import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialService } from "../configuration/credential-service";
import { AigcAssetService } from "./aigc-asset-service";
import { AigcConnectionService } from "./aigc-connection-service";
import { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcExecutionInput, AigcExecutionResult } from "./aigc-protocol-adapter";
import { AigcTaskRepository } from "./aigc-task-repository";
import { AigcTaskService } from "./aigc-task-service";
import { AigcWorkflowService } from "./aigc-workflow-service";

describe("AIGC 任务服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(adapterResult: AigcExecutionResult | Error | ((input: AigcExecutionInput) => Promise<AigcExecutionResult>), protocol: "openai" | "grok" = "openai") {
    const root = await mkdtemp(join(tmpdir(), "aigc-tasks-"));
    roots.push(root);
    const connections = new AigcConnectionService(join(root, "channels.json"));
    await connections.create({
      name: protocol === "openai" ? "OpenAI" : "Grok",
      type: protocol,
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      timeoutMs: 30_000,
    }, protocol, (await connections.read()).revision);
    const workflows = new AigcWorkflowService(join(root, "workflows.json"));
    const interfaces = new AigcInterfaceService(join(root, "interfaces.json"), (id) => workflows.exists(id));
    const created = await interfaces.create({
      name: "文生图",
      description: "",
      protocol,
      capability: "text-to-image",
      channelId: protocol,
      enabled: true,
      toolPublishEnabled: false,
      config: { model: "dall-e-3" },
    });
    const adapter = {
      execute: vi.fn(async (input: AigcExecutionInput) => {
        if (typeof adapterResult === "function") return adapterResult(input);
        if (adapterResult instanceof Error) throw adapterResult;
        return adapterResult;
      }),
    };
    const assets = new AigcAssetService(join(root, "assets"));
    const repository = new AigcTaskRepository(join(root, "tasks.json"));
    const service = new AigcTaskService({
      repository,
      interfaces,
      workflows,
      connections,
      credentials: new CredentialService(join(root, "auth.json")),
      assets,
      publicFiles: {} as never,
      adapters: { [protocol]: adapter },
    });
    return { service, item: created.item, adapter, assets, repository };
  }

  it("创建任务后异步执行并保存产物", async () => {
    const { service, item } = await fixture({
      assets: [{ name: "image.png", mediaType: "image/png", content: Buffer.from("png") }],
    });

    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "一只猫" } });

    expect(task.status).toBe("queued");
    await vi.waitFor(async () => {
      expect((await service.get(task.id))?.status).toBe("succeeded");
    });
    const done = await service.get(task.id);
    expect(done?.assets).toEqual([expect.objectContaining({ name: "image.png", mediaType: "image/png" })]);
  });

  it.each(["openai", "grok"] as const)("%s 接口拒绝 ComfyUI input 来源", async (protocol) => {
    const { service, item, adapter } = await fixture({ assets: [] }, protocol);

    await expect(service.createRun({
      interfaceId: item.id,
      inputs: {
        prompt: "测试",
        image: { filename: "source.png", name: "source.png", mediaType: "image/png", source: "comfyui_input" },
      },
    })).rejects.toThrow("仅 ComfyUI 接口支持 ComfyUI input");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("按任务和产物创建时间稳定排序产物", async () => {
    const { service, repository, item } = await fixture({ assets: [] });
    const base = {
      interfaceId: item.id,
      interfaceName: item.name,
      channelId: item.channelId,
      status: "succeeded" as const,
      inputs: {},
      updatedAt: "2026-09-09T10:00:00.000Z",
    };
    await repository.create({
      ...base,
      id: "task-z",
      createdAt: "2026-09-08T10:00:00.000Z",
      assets: [{ id: "asset-z", name: "older.png", mediaType: "image/png", size: 1, createdAt: "2026-09-08T10:00:01.000Z" }],
    });
    await repository.create({
      ...base,
      id: "task-a",
      createdAt: "2026-09-09T10:00:00.000Z",
      assets: [{ id: "asset-a", name: "newer.png", mediaType: "image/png", size: 1, createdAt: "2026-09-09T10:00:01.000Z" }],
    });

    const descending = await service.listOutputs({ kind: "image", sort: "desc", page: 1, pageSize: 24 });
    const ascending = await service.listOutputs({ kind: "image", sort: "asc", page: 1, pageSize: 24 });

    expect(descending.items.map((asset) => asset.name)).toEqual(["newer.png", "older.png"]);
    expect(ascending.items.map((asset) => asset.name)).toEqual(["older.png", "newer.png"]);
  });

});
