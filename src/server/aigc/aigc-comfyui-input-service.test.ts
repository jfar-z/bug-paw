import { describe, expect, it, vi } from "vitest";

import type { AigcChannelConfig } from "../../shared/aigc-contracts";
import { AigcComfyUiInputService, parseNodeMetadata } from "./aigc-comfyui-input-service";

describe("AigcComfyUiInputService", () => {
  it("从节点定义中解析 input 目录候选并推断媒体类型", async () => {
    const channel: AigcChannelConfig = {
      id: "comfy",
      name: "本机 ComfyUI",
      type: "comfyui",
      baseUrl: "http://127.0.0.1:8188",
      enabled: true,
    };
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:8188/object_info/LoadImage");
      expect(init?.headers).toMatchObject({ Accept: "application/json" });
      return new Response(JSON.stringify({
        LoadImage: {
          input: {
            required: {
              image: [["photo.png", "clip.mp4"], {}],
            },
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const service = new AigcComfyUiInputService(
      { read: async () => ({ revision: "r", channels: [channel] }) } as never,
      { getApiKey: async () => undefined } as never,
      request as never,
    );

    await expect(service.list("comfy", "LoadImage", "inputs.image")).resolves.toEqual([
      { filename: "photo.png", name: "photo.png", mediaType: "image/png" },
      { filename: "clip.mp4", name: "clip.mp4", mediaType: "video/mp4" },
    ]);
  });

  it("优先从 optional 字段读取候选并携带渠道凭证", async () => {
    const channel: AigcChannelConfig = {
      id: "comfy-key",
      name: "远程 ComfyUI",
      type: "comfyui",
      baseUrl: "https://comfy.example.com",
      enabled: true,
    };
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer secret" });
      return new Response(JSON.stringify({
        input: {
          optional: {
            audio: [["voice.wav"], {}],
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const service = new AigcComfyUiInputService(
      { read: async () => ({ revision: "r", channels: [channel] }) } as never,
      { getApiKey: async () => "secret" } as never,
      request as never,
    );

    await expect(service.list("comfy-key", "LoadAudio", "audio")).resolves.toEqual([
      { filename: "voice.wav", name: "voice.wav", mediaType: "audio/mpeg" },
    ]);
  });

  it("解析准确类型、标量枚举与字段控件约束", () => {
    expect(parseNodeMetadata({
      KSampler: {
        display_name: "采样器",
        category: "sampling",
        input: {
          required: {
            cfg: ["FLOAT", { default: 0, min: -1, max: 100, step: 0.1, round: 0.01 }],
            sampler: [["euler", 2, false], { default: 2, tooltip: "采样方式" }],
          },
          optional: {
            prompt: ["STRING", { multiline: true, placeholder: "输入提示词" }],
            image: [["dynamic-a.png", "dynamic-b.png"], { image_upload: true }],
          },
        },
      },
    }, "KSampler")).toEqual({
      displayName: "采样器",
      category: "sampling",
      fields: {
        "inputs.cfg": { comfyType: "FLOAT", valueType: "double", required: true, defaultValue: 0, min: -1, max: 100, step: 0.1, round: 0.01 },
        "inputs.sampler": { comfyType: "COMBO", valueType: "enum", required: true, defaultValue: 2, enumOptions: ["euler", 2, false], tooltip: "采样方式" },
        "inputs.prompt": { comfyType: "STRING", valueType: "string", required: false, multiline: true, placeholder: "输入提示词" },
        "inputs.image": { comfyType: "IMAGE", valueType: "image", required: false },
      },
    });
  });

  it("去重节点类型并保留部分成功的同步结果", async () => {
    const channel: AigcChannelConfig = { id: "comfy", name: "本机", type: "comfyui", baseUrl: "http://comfy", enabled: true };
    const request = vi.fn(async (input: string | URL | Request) => {
      const nodeClass = decodeURIComponent(String(input).split("/").at(-1) ?? "");
      if (nodeClass === "Missing") return new Response("not found", { status: 404 });
      return new Response(JSON.stringify({ [nodeClass]: { input: { required: { value: ["INT", { min: 0 }] } } } }), { status: 200 });
    });
    const service = new AigcComfyUiInputService(
      { read: async () => ({ revision: "r", channels: [channel] }) } as never,
      { getApiKey: async () => undefined } as never,
      request as never,
    );

    const result = await service.getNodeMetadata("comfy", ["Counter", "Counter", "Missing"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.syncedNodeClasses).toEqual(["Counter"]);
    expect(result.missingNodeClasses).toEqual(["Missing"]);
    expect(result.metadata.Counter.fields["inputs.value"]).toMatchObject({ valueType: "int", min: 0 });
  });
});
