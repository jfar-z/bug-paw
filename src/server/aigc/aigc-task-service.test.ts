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
    const service = new AigcTaskService({
      repository: new AigcTaskRepository(join(root, "tasks.json")),
      interfaces,
      workflows,
      connections,
      credentials: new CredentialService(join(root, "auth.json")),
      assets,
      publicFiles: {} as never,
      adapters: { [protocol]: adapter },
    });
    return { service, item: created.item, adapter, assets };
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

});
