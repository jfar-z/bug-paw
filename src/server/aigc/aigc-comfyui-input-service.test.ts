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

  it("通过可信渠道代理 input 内容并支持媒体分段请求", async () => {
    const channel: AigcChannelConfig = {
      id: "comfy-private",
      name: "内网 ComfyUI",
      type: "comfyui",
      baseUrl: "http://192.168.1.20:8188",
      enabled: true,
    };
    const request = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://192.168.1.20:8188/view?filename=clip.mp4&type=input&subfolder=references");
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.headers).toMatchObject({ Accept: "*/*", Range: "bytes=0-1023" });
      return new Response(Buffer.from("video"), {
        status: 206,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "5",
          "Accept-Ranges": "bytes",
          "Content-Range": "bytes 0-4/5",
          Server: "private-comfyui",
        },
      });
    });
    const service = new AigcComfyUiInputService(
      { read: async () => ({ revision: "r", channels: [channel] }) } as never,
      { getApiKey: async () => undefined } as never,
      request as never,
    );

    const content = await service.content("comfy-private", {
      filename: "clip.mp4",
      subfolder: "references",
      type: "input",
    }, "bytes=0-1023");
    expect(content).toMatchObject({
      status: 206,
      mediaType: "video/mp4",
      contentLength: "5",
      acceptRanges: "bytes",
      contentRange: "bytes 0-4/5",
    });
  });

  it("拒绝代理非 input 类型和包含控制字符的文件参数", async () => {
    const channel: AigcChannelConfig = { id: "comfy", name: "本机", type: "comfyui", baseUrl: "http://comfy", enabled: true };
    const request = vi.fn();
    const service = new AigcComfyUiInputService(
      { read: async () => ({ revision: "r", channels: [channel] }) } as never,
      { getApiKey: async () => undefined } as never,
      request as never,
    );

    await expect(service.content("comfy", { filename: "result.png", type: "output" })).rejects.toThrow("仅支持预览");
    await expect(service.content("comfy", { filename: "bad\nname.png" })).rejects.toThrow("参数无效");
    expect(request).not.toHaveBeenCalled();
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
      widgetInputs: [
        { name: "cfg" },
        { name: "sampler" },
        { name: "prompt" },
        { name: "image" },
      ],
    });
  });

  it("解析新版 COMBO options 并忽略不属于候选项的默认值", () => {
    expect(parseNodeMetadata({
      KSamplerSelect: {
        input: {
          required: {
            sampler_name: ["COMBO", { multiselect: false, options: ["euler", "dpmpp_2m"], default: "euler" }],
            scheduler: ["COMBO", { options: ["normal", "karras"], default: false }],
          },
        },
      },
    }, "KSamplerSelect")).toEqual({
      fields: {
        "inputs.sampler_name": { comfyType: "COMBO", valueType: "enum", required: true, defaultValue: "euler", enumOptions: ["euler", "dpmpp_2m"] },
        "inputs.scheduler": { comfyType: "COMBO", valueType: "enum", required: true, enumOptions: ["normal", "karras"] },
      },
      widgetInputs: [{ name: "sampler_name" }, { name: "scheduler" }],
    });
  });

  it("解析动态控件选项的子字段顺序", () => {
    expect(parseNodeMetadata({
      RTXVideoSuperResolution: {
        input: {
          required: {
            images: ["IMAGE"],
            resize_type: ["COMFY_DYNAMICCOMBO_V3", {
              options: [
                { key: "scale by multiplier", inputs: { required: { scale: ["FLOAT", { default: 2 }] } } },
                { key: "target dimensions", inputs: { required: { width: ["INT"], height: ["INT"] } } },
              ],
            }],
            quality: ["COMBO", { options: ["LOW", "ULTRA"] }],
          },
        },
      },
    }, "RTXVideoSuperResolution")?.widgetInputs).toEqual([
      {
        name: "resize_type",
        dynamicOptions: {
          "scale by multiplier": ["scale"],
          "target dimensions": ["width", "height"],
        },
      },
      { name: "quality" },
    ]);
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
