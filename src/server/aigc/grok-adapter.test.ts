import { describe, expect, it, vi } from "vitest";

import { GrokAigcAdapter } from "./grok-adapter";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

describe("GrokAigcAdapter", () => {
  function input(capability: AigcExecutionInput["item"]["capability"], inputs: Record<string, unknown>): AigcExecutionInput {
    return {
      item: {
        id: "grok-interface",
        name: "Grok 测试接口",
        description: "",
        protocol: "grok" as const,
        capability,
        channelId: "grok",
        enabled: true,
        toolPublishEnabled: false,
        config: { model: "grok-imagine-image-quality" },
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      },
      channel: {
        id: "grok",
        name: "Grok",
        type: "grok" as const,
        baseUrl: "https://api.x.ai/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
      apiKey: "sk-secret",
      inputs,
      assets: { resolveInputPath: vi.fn(async () => undefined) } as unknown as AigcExecutionInput["assets"],
      signal: new AbortController().signal,
    };
  }

  it("文生图按参考工具包提交 model、prompt、n 和 size", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const adapter = new GrokAigcAdapter(request as unknown as typeof fetch);

    await adapter.execute(input("text-to-image", { prompt: "一只猫", count: 2, size: "1024x1024" }));

    const [url, init] = request.mock.calls[0];
    expect(String(url)).toContain("/images/generations");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "一只猫",
      n: 2,
      size: "1024x1024",
    });
    expect((init?.headers as Record<string, string>)?.Authorization).toBe("Bearer sk-secret");
  });

  it("图片编辑使用 images/edits 端点并提交 image URL", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const adapter = new GrokAigcAdapter(request as unknown as typeof fetch);

    await adapter.execute(input("image-edit", {
      prompt: "改成漫画风",
      image: { url: "https://cdn.example.com/input.png", name: "input.png", mediaType: "image/png" },
    }));

    const [url, init] = request.mock.calls[0];
    expect(String(url)).toContain("/images/edits");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "grok-imagine-image-quality",
      prompt: "改成漫画风",
      image: { url: "https://cdn.example.com/input.png" },
    });
  });

  it("视频任务先提交再按 request_id 轮询", async () => {
    const request = vi.fn(async (inputUrl: string | URL | Request, _init?: RequestInit) => {
      const url = String(inputUrl);
      if (url.endsWith("/videos/generations")) {
        return new Response(JSON.stringify({ id: "request-1", status: "queued" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/videos/request-1") && request.mock.calls.filter(([value]) => String(value).endsWith("/videos/request-1")).length === 1) {
        return new Response(JSON.stringify({ status: "processing" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/videos/request-1")) {
        return new Response(JSON.stringify({ status: "succeeded", video: { url: "https://cdn.example.com/result.mp4" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(Buffer.from("video"), { status: 200, headers: { "Content-Type": "video/mp4" } });
    });
    const adapter = new GrokAigcAdapter(request as unknown as typeof fetch);

    const result = await adapter.execute(input("text-to-video", { prompt: "一只猫", duration: 5 }));

    expect(result.assets).toEqual([expect.objectContaining({ mediaType: "video/mp4" })]);
    expect(request.mock.calls.map(([value]) => String(value))).toEqual([
      "https://api.x.ai/v1/videos/generations",
      "https://api.x.ai/v1/videos/request-1",
      "https://api.x.ai/v1/videos/request-1",
      "https://cdn.example.com/result.mp4",
    ]);
    const [, init] = request.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "grok-imagine-image-quality",
      prompt: "一只猫",
      duration: 5,
    });
  });
});
