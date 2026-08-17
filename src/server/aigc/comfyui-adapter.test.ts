import { describe, expect, it, vi } from "vitest";

import type { AigcTaskExecutionState, AigcWorkflowDetail } from "../../shared/aigc-contracts";
import { ComfyUiAigcAdapter } from "./comfyui-adapter";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

class FakeSocket {
  private listener?: (event: { data: unknown }) => void;

  addEventListener(_type: "message", listener: (event: { data: unknown }) => void): void {
    this.listener = listener;
  }

  emit(message: unknown): void {
    this.listener?.({ data: JSON.stringify(message) });
  }

  close(): void {}
}

describe("ComfyUiAigcAdapter", () => {
  it("上传音频并结合节点事件下载音频产物", async () => {
    const socket = new FakeSocket();
    const states: AigcTaskExecutionState[] = [];
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/upload/image")) {
        const file = (init?.body as FormData).get("image") as File;
        expect(file.name).toBe("voice.wav");
        expect(file.type).toBe("audio/wav");
        return json({ name: "voice.wav" });
      }
      if (url.endsWith("/prompt")) return json({ prompt_id: "prompt-a" });
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-a"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-a")) {
        socket.emit({ type: "executing", data: { prompt_id: "prompt-a", node: "2" } });
        socket.emit({ type: "progress", data: { prompt_id: "prompt-a", node: "2", value: 7, max: 20 } });
        return json({ "prompt-a": { outputs: { "2": { audio: [{ filename: "result.wav", subfolder: "", type: "output" }] } } } });
      }
      if (url.includes("/view?")) return new Response(Buffer.from("wav"), { status: 200, headers: { "Content-Type": "audio/wav" } });
      throw new Error(`未处理请求 ${url}`);
    });
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => socket, 0);

    const result = await adapter.execute(input(audioWorkflow(), {
      voice: { assetId: "asset-a", name: "voice.wav", mediaType: "audio/wav" },
    }, (state) => states.push(state)));

    expect(result.assets).toEqual([{ name: "result.wav", mediaType: "audio/wav", content: Buffer.from("wav") }]);
    expect(states).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: "running", currentNodeId: "2", currentNodeName: "保存音频", progressValue: 7, progressMax: 20 }),
      expect.objectContaining({ phase: "downloading" }),
    ]));
  });

  it("未配置超时时可等待超过旧有一百二十次轮询上限", async () => {
    let historyRequests = 0;
    const controller = new AbortController();
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      expect(init?.signal).toBe(controller.signal);
      if (url.endsWith("/prompt")) return json({ prompt_id: "prompt-long" });
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-long"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-long")) {
        historyRequests += 1;
        return historyRequests <= 125
          ? json({})
          : json({ "prompt-long": { outputs: { "2": { images: [{ filename: "result.png" }] } } } });
      }
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const workflow = imageWorkflow();
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    const result = await adapter.execute(input(workflow, {}, undefined, controller));

    expect(historyRequests).toBe(126);
    expect(result.assets[0]).toMatchObject({ name: "result.png", mediaType: "image/png" });
  });
});

function input(
  workflow: AigcWorkflowDetail & { raw: unknown },
  inputs: Record<string, unknown>,
  onProgress?: AigcExecutionInput["onProgress"],
  controller = new AbortController(),
): AigcExecutionInput {
  return {
    item: {
      id: "comfy-interface",
      name: "ComfyUI 测试接口",
      description: "",
      protocol: "comfyui",
      capability: "text-to-image",
      channelId: "comfy",
      enabled: true,
      toolPublishEnabled: false,
      config: { workflowId: workflow.id },
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
    },
    channel: { id: "comfy", name: "ComfyUI", type: "comfyui", baseUrl: "http://127.0.0.1:8188", enabled: true },
    inputs,
    assets: { resolveInputPath: vi.fn(async () => "/etc/hostname") } as unknown as AigcExecutionInput["assets"],
    workflows: { getPrivate: vi.fn(async () => ({ ...workflow, raw: workflow.raw })) } as unknown as AigcExecutionInput["workflows"],
    signal: controller.signal,
    onProgress,
  };
}

function audioWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    id: "workflow-audio",
    name: "音频工作流",
    fileName: "audio.json",
    originalHash: "hash",
    raw: {
      "1": { class_type: "LoadAudio", inputs: { audio: "" } },
      "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } },
    },
    nodes: [
      { id: "1", type: "LoadAudio", title: "载入音频", fields: [] },
      { id: "2", type: "SaveAudio", title: "保存音频", fields: [] },
    ],
    edges: [],
    inputMappings: [{ id: "voice", name: "voice", nodeId: "1", field: "inputs.audio", type: "audio", required: true }],
    outputMappings: [{ id: "result", name: "result", nodeId: "2", field: "outputs.audio", mediaType: "audio" }],
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  };
}

function imageWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...audioWorkflow(),
    id: "workflow-image",
    raw: { "2": { class_type: "SaveImage", inputs: {} } },
    inputMappings: [],
    outputMappings: [{ id: "result", name: "result", nodeId: "2", field: "outputs.images", mediaType: "image" }],
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
