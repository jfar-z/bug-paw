import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialService } from "../configuration/credential-service";
import { AigcAssetService } from "./aigc-asset-service";
import { AigcConnectionService } from "./aigc-connection-service";
import { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcExecutionResult } from "./aigc-protocol-adapter";
import { AigcTaskRepository } from "./aigc-task-repository";
import { AigcTaskService } from "./aigc-task-service";
import { AigcWorkflowService } from "./aigc-workflow-service";

describe("AIGC 任务服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(adapterResult: AigcExecutionResult | Error) {
    const root = await mkdtemp(join(tmpdir(), "aigc-tasks-"));
    roots.push(root);
    const connections = new AigcConnectionService(join(root, "channels.json"));
    await connections.create({
      name: "OpenAI",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      timeoutMs: 30_000,
    }, "openai", (await connections.read()).revision);
    const workflows = new AigcWorkflowService(join(root, "workflows.json"));
    const interfaces = new AigcInterfaceService(join(root, "interfaces.json"), (id) => workflows.exists(id));
    const created = await interfaces.create({
      name: "文生图",
      description: "",
      protocol: "openai",
      capability: "text-to-image",
      channelId: "openai",
      enabled: true,
      toolPublishEnabled: false,
      config: { model: "dall-e-3" },
    });
    const adapter = {
      execute: vi.fn(async () => {
        if (adapterResult instanceof Error) throw adapterResult;
        return adapterResult;
      }),
    };
    const service = new AigcTaskService({
      repository: new AigcTaskRepository(join(root, "tasks.json")),
      interfaces,
      workflows,
      connections,
      credentials: new CredentialService(join(root, "auth.json")),
      assets: new AigcAssetService(join(root, "assets")),
      adapters: { openai: adapter },
    });
    return { service, item: created.item, adapter };
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

  it("上游失败时写入脱敏错误状态", async () => {
    const { service, item } = await fixture(new Error("上游服务返回 401"));

    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "一只猫" } });
    await vi.waitFor(async () => {
      expect((await service.get(task.id))?.status).toBe("failed");
    });
    expect((await service.get(task.id))?.error).toMatchObject({ code: "AIGC_UPSTREAM_FAILED" });
  });

  it("失败任务可以重试", async () => {
    const { service, item } = await fixture(new Error("临时失败"));
    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "一只猫" } });
    await vi.waitFor(async () => {
      expect((await service.get(task.id))?.status).toBe("failed");
    });

    const retried = await service.retry(task.id);
    expect(retried?.status).toBe("queued");
  });
});
