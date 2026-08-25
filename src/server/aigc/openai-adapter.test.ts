import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiAigcAdapter } from "./openai-adapter";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

describe("OpenAiAigcAdapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("图片生成与编辑接口未提供图片时调用生成端点并映射自定义参数", async () => {
    const request = successfulRequest();
    const adapter = new OpenAiAigcAdapter(request as unknown as typeof fetch);

    await adapter.execute(input({
      prompt: "一只猫",
      image_size: "1536x1024",
      ignored: "不会透传",
    }));

    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/v1/images/generations");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "image-model",
      prompt: "一只猫",
      image_size: "1536x1024",
      quality: "high",
    });
  });

  it("提供图片时调用编辑端点并以 multipart 发送自定义参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-image-edit-"));
    roots.push(root);
    const imagePath = join(root, "source.png");
    await writeFile(imagePath, Buffer.from("image"));
    const request = successfulRequest();
    const adapter = new OpenAiAigcAdapter(request as unknown as typeof fetch);

    await adapter.execute(input({
      prompt: "改成水彩风",
      image: { assetId: "asset-1", name: "source.png", mediaType: "image/png" },
      image_size: "1024x1024",
      quality: "medium",
    }, imagePath));

    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/v1/images/edits");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("image-model");
    expect(form.get("prompt")).toBe("改成水彩风");
    expect(form.get("image_size")).toBe("1024x1024");
    expect(form.get("quality")).toBe("medium");
    expect(form.get("image")).toBeInstanceOf(File);
  });

  it("公共目录图片通过公共文件服务解析并调用编辑端点", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-public-image-edit-"));
    roots.push(root);
    const imagePath = join(root, "public.png");
    await writeFile(imagePath, Buffer.from("public-image"));
    const request = successfulRequest();
    const adapter = new OpenAiAigcAdapter(request as unknown as typeof fetch);
    const execution = input({
      prompt: "改成油画风",
      image: { assetId: "public-asset", name: "public.png", mediaType: "image/png", source: "public" },
    }, undefined, imagePath);

    await adapter.execute(execution);

    expect(execution.publicFiles?.resolvePath).toHaveBeenCalledWith("public-asset");
    expect(execution.assets.resolveInputPath).not.toHaveBeenCalled();
    expect(String(request.mock.calls[0][0])).toBe("https://api.example.test/v1/images/edits");
  });

  function input(inputs: Record<string, unknown>, imagePath?: string, publicImagePath?: string): AigcExecutionInput {
    return {
      item: {
        id: "openai-interface",
        name: "图片生成与编辑",
        description: "",
        protocol: "openai",
        capability: "image-edit",
        channelId: "openai",
        enabled: true,
        toolPublishEnabled: false,
        config: {
          model: "image-model",
          parameters: [
            { name: "image_size", type: "string", description: "尺寸" },
            { name: "quality", type: "string", enumValues: ["medium", "high"], defaultValue: "high", description: "质量" },
          ],
        },
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
      channel: {
        id: "openai",
        name: "OpenAI Compatible",
        type: "openai",
        baseUrl: "https://api.example.test/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
      inputs,
      assets: { resolveInputPath: vi.fn(async () => imagePath) } as unknown as AigcExecutionInput["assets"],
      publicFiles: { resolvePath: vi.fn(async () => publicImagePath) } as unknown as AigcExecutionInput["publicFiles"],
      signal: new AbortController().signal,
    };
  }
});

function successfulRequest() {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}
