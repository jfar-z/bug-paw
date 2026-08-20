import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AigcInterfaceService } from "./aigc-interface-service";

describe("AIGC 接口服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "aigc-interfaces-"));
    roots.push(root);
    return new AigcInterfaceService(join(root, "interfaces.json"), async () => true);
  }

  it("接受 Grok 图片编辑与视频编辑能力", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "Grok 图片编辑",
      description: "",
      protocol: "grok",
      capability: "image-edit",
      channelId: "grok",
      enabled: true,
      toolPublishEnabled: false,
      config: { model: "grok-imagine-image-quality", size: "1024x1024" },
    });

    expect(created.item.capability).toBe("image-edit");
    expect(created.item.config).toEqual({ model: "grok-imagine-image-quality", size: "1024x1024" });
  });
});
