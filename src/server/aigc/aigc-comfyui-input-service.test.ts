import { describe, expect, it, vi } from "vitest";

import type { AigcChannelConfig } from "../../shared/aigc-contracts";
import { AigcComfyUiInputService } from "./aigc-comfyui-input-service";

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
});
