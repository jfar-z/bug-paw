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

  it("为旧版 OpenAI 配置生成可编辑参数定义", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "兼容图片接口",
      description: "",
      protocol: "openai",
      capability: "image-edit",
      channelId: "openai",
      enabled: true,
      toolPublishEnabled: false,
      config: { model: "image-model", size: "1024x1024", quality: "high", responseFormat: "b64_json" },
    });

    expect(created.item.config).toEqual({
      model: "image-model",
      parameters: [
        expect.objectContaining({ name: "size", type: "string", defaultValue: "1024x1024" }),
        expect.objectContaining({ name: "quality", type: "string", defaultValue: "high" }),
        expect.objectContaining({ name: "response_format", type: "string", defaultValue: "b64_json" }),
      ],
    });
  });

  it("校验 OpenAI 参数类型、枚举、默认值和保留字段", async () => {
    const service = await fixture();
    const base = {
      name: "自定义图片接口",
      description: "",
      protocol: "openai" as const,
      capability: "image-edit" as const,
      channelId: "openai",
      enabled: true,
      toolPublishEnabled: false,
    };
    const created = await service.create({
      ...base,
      config: {
        model: "image-model",
        parameters: [
          { name: "image_size", type: "string", enumValues: ["1024x1024", "1536x1024"], defaultValue: "1024x1024", description: "尺寸" },
          { name: "steps", type: "integer", defaultValue: 20, description: "步数" },
        ],
      },
    });

    expect(created.item.config).toMatchObject({
      parameters: [
        { name: "image_size", type: "string", enumValues: ["1024x1024", "1536x1024"], defaultValue: "1024x1024", description: "尺寸" },
        { name: "steps", type: "integer", defaultValue: 20, description: "步数" },
      ],
    });
    await expect(service.create({
      ...base,
      config: { model: "image-model", parameters: [{ name: "prompt", type: "string", description: "冲突" }] },
    })).rejects.toThrow("系统保留字段");
    await expect(service.create({
      ...base,
      config: { model: "image-model", parameters: [{ name: "quality", type: "string", enumValues: ["low"], defaultValue: "high", description: "质量" }] },
    })).rejects.toThrow("默认值不在枚举范围内");
  });
});
