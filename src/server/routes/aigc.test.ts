// @vitest-environment node

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AigcTaskRecord } from "../../shared/aigc-contracts";
import { registerAigcRoutes } from "./aigc";

const roots: string[] = [];

describe("AIGC 产物路由", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("默认允许工作台内联预览，并仅在明确请求时下载", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-aigc-asset-"));
    roots.push(root);
    const assetPath = join(root, "asset.png");
    await writeFile(assetPath, Buffer.from("image-content", "utf8"));
    const task: AigcTaskRecord = {
      id: "task-1",
      interfaceId: "interface-1",
      interfaceName: "ComfyUI",
      channelId: "channel-1",
      status: "succeeded",
      inputs: {},
      assets: [{ id: "asset-1", name: "成品.png", mediaType: "image/png", size: 13, createdAt: "2026-08-17T00:00:00.000Z" }],
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {} as never,
      interfaces: {} as never,
      tasks: { get: async () => task } as never,
      assets: { resolveOutputPath: async () => assetPath } as never,
      publicFiles: {} as never,
      comfyuiInputs: {} as never,
    });
    await app.ready();

    const inline = await app.inject({ method: "GET", url: "/api/aigc/tasks/task-1/assets/asset-1" });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toContain("image/png");
    expect(inline.headers["content-disposition"]).toBeUndefined();
    expect(inline.headers["x-content-type-options"]).toBe("nosniff");

    const download = await app.inject({ method: "GET", url: "/api/aigc/tasks/task-1/assets/asset-1?download=1" });
    expect(download.statusCode, download.body).toBe(200);
    expect(download.headers["content-disposition"]).toContain("attachment");
    await app.close();
  });

  it("提供产物分页、任务删除与图片缩略图接口", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-aigc-thumbnail-"));
    roots.push(root);
    const thumbnailPath = join(root, "thumbnail.webp");
    await writeFile(thumbnailPath, Buffer.from("thumbnail", "utf8"));
    const task: AigcTaskRecord = {
      id: "task-1", interfaceId: "interface-1", interfaceName: "ComfyUI", channelId: "channel-1", status: "succeeded", inputs: {},
      assets: [{ id: "asset-1", name: "成品.png", mediaType: "image/png", size: 13, createdAt: "2026-08-17T00:00:00.000Z" }],
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const removed: string[] = [];
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {} as never,
      interfaces: {} as never,
      tasks: {
        get: async () => task,
        listOutputs: async () => ({ items: [], counts: { image: 1, video: 0, audio: 0, other: 0 }, page: 1, pageSize: 24, total: 1, totalPages: 1 }),
        remove: async (id: string) => { removed.push(id); return task; },
      } as never,
      assets: { resolveThumbnailPath: async () => thumbnailPath } as never,
      publicFiles: {} as never,
      comfyuiInputs: {} as never,
    });
    await app.ready();

    const page = await app.inject({ method: "GET", url: "/api/aigc/outputs?kind=image&sort=desc&page=1&pageSize=24" });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ counts: { image: 1 }, page: 1 });
    const thumbnail = await app.inject({ method: "GET", url: "/api/aigc/tasks/task-1/assets/asset-1/thumbnail" });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers["content-type"]).toContain("image/webp");
    expect(thumbnail.headers["cache-control"]).toContain("immutable");
    expect((await app.inject({ method: "DELETE", url: "/api/aigc/tasks/task-1" })).statusCode).toBe(204);
    expect(removed).toEqual(["task-1"]);
    await app.close();
  });
});

describe("AIGC 工作流节点元数据路由", () => {
  it("同步节点定义并返回新的配置版本和摘要", async () => {
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {
        get: async () => ({ revision: "r1", workflow: { nodes: [{ type: "KSampler" }, { type: "KSampler" }] } }),
        syncNodeMetadata: async () => ({ revision: "r2", workflow: { id: "workflow-1", nodeMetadataSyncedAt: "2026-08-20T08:00:00.000Z" } }),
      } as never,
      interfaces: {} as never,
      tasks: {} as never,
      assets: {} as never,
      publicFiles: {} as never,
      comfyuiInputs: {
        getNodeMetadata: async () => ({
          metadata: { KSampler: { fields: {} } },
          syncedNodeClasses: ["KSampler"],
          missingNodeClasses: [],
          syncedAt: "2026-08-20T08:00:00.000Z",
        }),
      } as never,
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/aigc/workflows/workflow-1/sync-node-metadata",
      payload: { channelId: "comfy", revision: "r1" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ revision: "r2", syncedNodeClasses: ["KSampler"], workflow: { id: "workflow-1" } });
    await app.close();
  });
});
