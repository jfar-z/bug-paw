// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AigcTaskRecord } from "../../shared/aigc-contracts";
import { AigcAssetService } from "./aigc-asset-service";
import { AigcMediaProjectService } from "./aigc-media-project-service";
import type { AigcMediaRenderRequest } from "./aigc-media-renderer";

const roots: string[] = [];

describe("AIGC 轻剪辑工程服务", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("保存视频与图片片段，并保留视频原音元数据", async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create({ kind: "video" });
    const updated = await fixture.service.update(project.id, {
      revision: project.revision,
      name: "发布片",
      clips: [
        { id: "clip-video", source: { taskId: "task-video", assetId: fixture.video.id }, trimStartMs: 1000, trimEndMs: 5000 },
        { id: "clip-image", source: { taskId: "task-image", assetId: fixture.image.id }, trimStartMs: 0, imageDurationMs: 2500 },
      ],
    });

    expect(updated.name).toBe("发布片");
    expect(updated.clips[0]).toMatchObject({ kind: "video", hasAudio: true, trimStartMs: 1000, trimEndMs: 5000 });
    expect(updated.clips[1]).toMatchObject({ kind: "image", hasAudio: false, imageDurationMs: 2500 });
    await expect(fixture.service.update(project.id, { revision: project.revision, name: "旧版本", clips: [] })).rejects.toThrow("其他页面更新");
  });

  it("拒绝把音频加入视频工程", async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create({ kind: "video" });
    await expect(fixture.service.update(project.id, {
      revision: project.revision,
      name: project.name,
      clips: [{ id: "clip-audio", source: { taskId: "task-audio", assetId: fixture.audio.id }, trimStartMs: 0 }],
    })).rejects.toThrow("视频工程只能添加视频或图片产物");
  });

  it("调整已有片段时复用媒体元数据，避免重复探测", async () => {
    const fixture = await createFixture();
    const project = await fixture.service.create({ kind: "video" });
    const first = await fixture.service.update(project.id, {
      revision: project.revision,
      name: project.name,
      clips: [{ id: "clip-video", source: { taskId: "task-video", assetId: fixture.video.id }, trimStartMs: 0, trimEndMs: 5000 }],
    });
    const second = await fixture.service.update(first.id, {
      revision: first.revision,
      name: first.name,
      clips: [{ id: "clip-video", source: { taskId: "task-video", assetId: fixture.video.id }, trimStartMs: 1000, trimEndMs: 4000 }],
    });

    expect(second.clips[0]).toMatchObject({ trimStartMs: 1000, trimEndMs: 4000, hasAudio: true });
    expect(fixture.mediaRenderer.probe).toHaveBeenCalledTimes(1);
  });

  it("全局只执行一个导出任务，并为后续任务返回排队位置", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const fixture = await createFixture({
      render: vi.fn(async (request: { outputPath: string; onProgress?: (value: number) => void }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        request.onProgress?.(0.5);
        await new Promise<void>((resolve) => releases.push(resolve));
        await writeFile(request.outputPath, "rendered", "utf8");
        active -= 1;
        return 8;
      }),
    });
    const first = await createAudioProject(fixture.service, fixture.audio.id, "一", "clip-one");
    const second = await createAudioProject(fixture.service, fixture.audio.id, "二", "clip-two");

    const firstJob = await fixture.service.render(first.id);
    const secondJob = await fixture.service.render(second.id);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect((await fixture.service.getRender(firstJob.id))?.status).toBe("running");
    expect(await fixture.service.getRender(secondJob.id)).toMatchObject({ status: "queued", queuePosition: 1 });
    expect(maximumActive).toBe(1);

    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    expect((await fixture.service.getRender(secondJob.id))?.status).toBe("running");
    expect(maximumActive).toBe(1);
    releases.shift()?.();
    await vi.waitFor(async () => expect((await fixture.service.getRender(secondJob.id))?.status).toBe("succeeded"));
  });
});

async function createFixture(renderer?: { render: (request: AigcMediaRenderRequest) => Promise<number> }) {
  const root = await mkdtemp(join(tmpdir(), "aigc-media-project-"));
  roots.push(root);
  const assets = new AigcAssetService(join(root, "assets"));
  const video = await assets.saveOutput("task-video", Buffer.from("video"), "scene.mp4", "video/mp4");
  const image = await assets.saveOutput("task-image", Buffer.from("image"), "cover.png", "image/png");
  const audio = await assets.saveOutput("task-audio", Buffer.from("audio"), "voice.wav", "audio/wav");
  const tasks = new Map<string, AigcTaskRecord>([
    ["task-video", task("task-video", video)],
    ["task-image", task("task-image", image)],
    ["task-audio", task("task-audio", audio)],
  ]);
  const mediaRenderer = {
    probe: vi.fn(async (path: string) => path.includes(video.id)
      ? { durationMs: 10_000, hasAudio: true, width: 1280, height: 720 }
      : { durationMs: 6_000, hasAudio: true }),
    render: renderer?.render ?? vi.fn(async (request: { outputPath: string }) => {
      await writeFile(request.outputPath, "rendered", "utf8");
      return 8;
    }),
  };
  const service = new AigcMediaProjectService({
    filePath: join(root, "projects.json"),
    outputRoot: join(root, "renders"),
    tasks: { get: async (id: string) => tasks.get(id) },
    assets,
    renderer: mediaRenderer,
  });
  return { service, video, image, audio, mediaRenderer };
}

async function createAudioProject(service: AigcMediaProjectService, assetId: string, name: string, clipId: string) {
  const project = await service.create({ kind: "audio", name });
  return service.update(project.id, {
    revision: project.revision,
    name,
    clips: [{ id: clipId, source: { taskId: "task-audio", assetId }, trimStartMs: 0, trimEndMs: 3000 }],
  });
}

function task(id: string, asset: AigcTaskRecord["assets"][number]): AigcTaskRecord {
  return {
    id, interfaceId: "interface", interfaceName: "测试", channelId: "channel", status: "succeeded", inputs: {}, assets: [asset],
    createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
  };
}
