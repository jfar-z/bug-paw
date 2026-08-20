import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { AigcPublicFileService } from "./aigc-public-file-service";

describe("AIGC 公共文件服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "aigc-public-files-"));
    roots.push(root);
    return new AigcPublicFileService(root);
  }

  it("保存后可从列表读取并解析文件路径", async () => {
    const service = await fixture();
    const saved = await service.save(Readable.from([Buffer.from("image")]), "示例.png", "image/png");

    expect(saved).toMatchObject({ name: "示例.png", mediaType: "image/png", size: 5 });
    expect(await service.list()).toEqual([expect.objectContaining({ id: saved.id })]);
    expect(await service.resolvePath(saved.id)).toContain(saved.id);
  });

  it("删除后不再返回列表或路径", async () => {
    const service = await fixture();
    const saved = await service.save(Readable.from([Buffer.from("image")]), "示例.png", "image/png");

    await expect(service.remove(saved.id)).resolves.toBe(true);
    await expect(service.remove(saved.id)).resolves.toBe(false);
    expect(await service.list()).toEqual([]);
    expect(await service.resolvePath(saved.id)).toBeUndefined();
  });

  it("以逻辑目录管理公开文件且移动改名不改变稳定标识", async () => {
    const service = await fixture();
    await service.createDirectory("", "素材");
    const saved = await service.save(Readable.from([Buffer.from("image")]), "示例.png", "image/png", "素材");

    expect(await service.listEntries("素材")).toEqual([expect.objectContaining({ id: saved.id, path: "素材/示例.png", kind: "file" })]);
    await service.moveEntry("素材/示例.png", "归档/图片", true);
    const renamed = await service.renameEntry("归档/图片/示例.png", "封面.png");

    expect(renamed).toMatchObject({ id: saved.id, path: "归档/图片/封面.png" });
    expect(await service.searchEntries("封面")).toEqual([expect.objectContaining({ id: saved.id })]);
    expect(await service.resolvePath(saved.id)).toContain(saved.id);
  });

  it("批量删除目录时同步清理子文件实体", async () => {
    const service = await fixture();
    await service.createDirectory("", "临时");
    const saved = await service.save(Readable.from([Buffer.from("hello")]), "说明.txt", "text/plain", "临时");

    expect(await service.readText("临时/说明.txt")).toMatchObject({ content: "hello", truncated: false });
    await service.removeEntries(["临时"]);

    expect(await service.listEntries("")).toEqual([]);
    expect(await service.resolvePath(saved.id)).toBeUndefined();
  });
});
