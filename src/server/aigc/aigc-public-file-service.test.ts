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
});
