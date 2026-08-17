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

  async function fixture(adapterResult: AigcExecutionResult | Error | ((input: AigcExecutionInput) => Promise<AigcExecutionResult>)) {
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
      adapters: { openai: adapter },
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

  it("实时进度仅附加到运行中任务并在终态清除", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const { service, item } = await fixture(async (input) => {
      input.onProgress?.({
        phase: "running",
        currentNodeId: "12",
        currentNodeName: "KSampler",
        progressValue: 3,
        progressMax: 20,
        updatedAt: new Date().toISOString(),
      });
      await pending;
      return { assets: [{ name: "image.png", mediaType: "image/png", content: Buffer.from("png") }] };
    });

    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "一只猫" } });
    await vi.waitFor(async () => {
      expect((await service.get(task.id))?.execution).toMatchObject({ currentNodeId: "12", progressValue: 3 });
    });
    finish?.();
    await vi.waitFor(async () => {
      const done = await service.get(task.id);
      expect(done?.status).toBe("succeeded");
      expect(done?.execution).toBeUndefined();
    });
  });

  it("按媒体类型铺平产物并按任务标识分页排序", async () => {
    const { service, item } = await fixture({
      assets: [
        { name: "cover.png", mediaType: "image/png", content: Buffer.from("image") },
        { name: "clip.mp4", mediaType: "video/mp4", content: Buffer.from("video") },
        { name: "voice.mp3", mediaType: "audio/mpeg", content: Buffer.from("audio") },
        { name: "meta.json", mediaType: "application/json", content: Buffer.from("{}") },
      ],
    });
    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "测试" } });
    await vi.waitFor(async () => expect((await service.get(task.id))?.status).toBe("succeeded"));

    const images = await service.listOutputs({ kind: "image", sort: "desc", page: 1, pageSize: 24 });

    expect(images).toMatchObject({ page: 1, pageSize: 24, total: 1, totalPages: 1, counts: { image: 1, video: 1, audio: 1, other: 1 } });
    expect(images.items[0]).toMatchObject({ taskId: task.id, name: "cover.png", kind: "image" });
  });

  it("删除活动任务时先中止执行并清理任务记录", async () => {
    const { service, item } = await fixture((input) => new Promise<AigcExecutionResult>((_resolve, reject) => {
      input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "测试" } });
    await vi.waitFor(async () => expect((await service.get(task.id))?.status).toBe("running"));

    await expect(service.remove(task.id)).resolves.toMatchObject({ id: task.id });
    await expect(service.get(task.id)).resolves.toBeUndefined();
  });

  it("删除完成任务时同步删除原产物和缩略图", async () => {
    const png = await import("sharp").then(({ default: sharp }) => sharp({ create: { width: 8, height: 8, channels: 3, background: "#ffffff" } }).png().toBuffer());
    const { service, item, assets } = await fixture({ assets: [{ name: "cover.png", mediaType: "image/png", content: png }] });
    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "测试" } });
    await vi.waitFor(async () => expect((await service.get(task.id))?.status).toBe("succeeded"));
    const asset = (await service.get(task.id))!.assets[0];
    expect(await assets.resolveThumbnailPath(task.id, asset.id)).toBeDefined();

    await service.remove(task.id);

    await expect(assets.resolveOutputPath(task.id, asset.id)).resolves.toBeUndefined();
    await expect(assets.resolveThumbnailPath(task.id, asset.id)).resolves.toBeUndefined();
  });
});
