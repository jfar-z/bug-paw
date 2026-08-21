// @vitest-environment node

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    expect(inline.headers["accept-ranges"]).toBe("bytes");

    const range = await app.inject({ method: "GET", url: "/api/aigc/tasks/task-1/assets/asset-1", headers: { range: "bytes=2-6" } });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe("bytes 2-6/13");
    expect(range.body).toBe("age-c");

    const invalidRange = await app.inject({ method: "GET", url: "/api/aigc/tasks/task-1/assets/asset-1", headers: { range: "bytes=99-100" } });
    expect(invalidRange.statusCode).toBe(416);
    expect(invalidRange.headers["content-range"]).toBe("bytes */13");

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

describe("AIGC 轻剪辑路由", () => {
  it("提供工程 CRUD、导出状态与取消接口", async () => {
    const project = {
      id: "project-1", revision: "revision-1", name: "视频工程", kind: "video" as const, clips: [],
      createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const job = {
      id: "render-1", projectId: project.id, projectName: project.name, kind: project.kind,
      status: "queued" as const, progress: 0, queuePosition: 1, createdAt: "2026-08-21T00:00:00.000Z",
    };
    const remove = vi.fn(async () => undefined);
    const mediaProjects = {
      list: async () => ({ projects: [project] }),
      create: async () => project,
      get: async (id: string) => id === project.id ? project : undefined,
      update: async () => ({ ...project, revision: "revision-2", name: "成片" }),
      remove,
      render: async () => job,
      getRender: async (id: string) => id === job.id ? job : undefined,
      cancelRender: async () => ({ ...job, status: "cancelled" as const }),
      resolveRenderPath: async () => undefined,
    };
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {} as never,
      interfaces: {} as never,
      tasks: {} as never,
      assets: {} as never,
      publicFiles: {} as never,
      comfyuiInputs: {} as never,
      mediaProjects: mediaProjects as never,
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/aigc/media-projects" })).json()).toMatchObject({ projects: [{ id: project.id }] });
    expect((await app.inject({ method: "POST", url: "/api/aigc/media-projects", payload: { kind: "video" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/aigc/media-projects/${project.id}` })).statusCode).toBe(200);
    const update = await app.inject({
      method: "PATCH", url: `/api/aigc/media-projects/${project.id}`,
      payload: { revision: project.revision, name: "成片", clips: [] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ revision: "revision-2", name: "成片" });
    expect((await app.inject({ method: "POST", url: `/api/aigc/media-projects/${project.id}/render` })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: `/api/aigc/media-renders/${job.id}` })).json()).toMatchObject({ status: "queued", queuePosition: 1 });
    expect((await app.inject({ method: "POST", url: `/api/aigc/media-renders/${job.id}/cancel` })).json()).toMatchObject({ status: "cancelled" });
    expect((await app.inject({ method: "DELETE", url: `/api/aigc/media-projects/${project.id}` })).statusCode).toBe(204);
    expect(remove).toHaveBeenCalledWith(project.id);
    await app.close();
  });
});
