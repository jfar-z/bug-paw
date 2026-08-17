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
});
