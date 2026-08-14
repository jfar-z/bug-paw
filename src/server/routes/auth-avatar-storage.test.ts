// @vitest-environment node

import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { persistAvatarFile } from "./auth";

describe("用户头像文件落盘", () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("重命名失败时删除已写入的临时文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "bug-paw-avatar-storage-"));
    temporaryRoots.push(root);
    const finalPath = join(root, "existing-directory");
    await mkdir(finalPath);

    await expect(persistAvatarFile(finalPath, Buffer.from("avatar"))).rejects.toBeDefined();
    await expect(stat(`${finalPath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
