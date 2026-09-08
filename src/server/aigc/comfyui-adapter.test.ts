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

it.each([true, false])("取消仅移除自己的排队任务，排队状态=%s", async (queued) => {
    const controller = new AbortController();
    let removed = false;
    const requests: { url: string; body?: string }[] = [];
    const request = vi.fn(async (value: string | URL | Request, init?: RequestInit) => {
      const url = String(value);
      requests.push({ url, body: init?.body as string | undefined });
      if (url.endsWith("/prompt")) return json({ prompt_id: "owned-prompt" });
      if (url.endsWith("/queue")) {
        if (init?.method === "POST") { removed = true; return new Response(null, { status: 200 }); }
        return json({
          queue_pending: queued && !removed ? [[0, "owned-prompt"], [1, "other-prompt"]] : [[1, "other-prompt"]],
          queue_running: queued ? [] : [[0, "owned-prompt"]],
        });
      }
      if (url.endsWith("/history/owned-prompt")) { controller.abort(); return json({}); }
      throw new Error("unexpected request");
    });
    const execution = input(imageWorkflow(), {}, undefined, controller);
    execution.onCancellation = vi.fn();
    await expect(new ComfyUiAigcAdapter(request as typeof fetch, () => undefined, 0).execute(execution)).rejects.toThrow();
    expect(execution.onCancellation).toHaveBeenCalledWith(queued ? "confirmed" : "unknown");
    expect(requests.some((entry) => entry.url.endsWith("/interrupt"))).toBe(false);
    expect(requests.filter((entry) => entry.body?.includes("delete")).map((entry) => JSON.parse(entry.body!)))
      .toEqual(queued ? [{ delete: ["owned-prompt"] }] : []);
  });

it("条件参数有值时保留节点组并上传媒体", async () => {
    let submittedPrompt: Record<string, unknown> | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/upload/image")) return json({ name: "reference-2.png" });
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
        return json({ prompt_id: "prompt-conditional" });
      }
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-conditional"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-conditional")) return json({ "prompt-conditional": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const execution = input(conditionalWorkflow(), {
      reference_image_2: { assetId: "asset-reference-2", name: "reference-2.png", mediaType: "image/png" },
    });
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    const result = await adapter.execute(execution);

    expect(execution.assets.resolveInputPath).toHaveBeenCalledWith("asset-reference-2");
    expect(submittedPrompt).toHaveProperty("34.inputs.image", "reference-2.png");
    expect(submittedPrompt).toHaveProperty("47.inputs.image", ["34", 0]);
    expect(result.assets[0]).toMatchObject({ outputId: "result", outputName: "result" });
  });

it("提供可选入参时临时启用对应的 Bypass 条件分支", async () => {
    let submittedPrompt: Record<string, unknown> | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
        return json({ prompt_id: "prompt-bypass-activated" });
      }
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-bypass-activated"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-bypass-activated")) return json({ "prompt-bypass-activated": { outputs: { "4": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const workflow = bypassWorkflow();
    workflow.inputMappings = [{
      id: "reference-video",
      name: "reference_video",
      nodeId: "5",
      field: "widgets_values.0",
      type: "video",
      required: false,
      activation: { when: "provided", nodeIds: ["5", "6"] },
    }];
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await adapter.execute(input(workflow, {
      reference_video: { source: "comfyui_input", filename: "reference.mp4" },
    }));

    expect(submittedPrompt).toHaveProperty("5.inputs.file", "reference.mp4");
    expect(submittedPrompt).not.toHaveProperty("5.inputs.0");
    expect(submittedPrompt).toHaveProperty("6.inputs.video", ["5", 0]);
    expect(submittedPrompt).toHaveProperty("7.inputs.reference_image", ["6", 0]);
    expect(submittedPrompt).toHaveProperty("7.inputs.reference_audio", ["6", 1]);
  });

it("具名控件值忽略随机种子前端控制项并保持后续字段类型", async () => {
  let submittedPrompt: Record<string, unknown> | undefined;
  const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
    const url = String(requestInput);
    if (url.endsWith("/prompt")) {
      submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
      return json({ prompt_id: "prompt-named-widgets" });
    }
    if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-named-widgets"]], queue_pending: [] });
    if (url.endsWith("/history/prompt-named-widgets")) {
      return json({ "prompt-named-widgets": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
    }
    if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
    throw new Error(`未处理请求 ${url}`);
  });

  await new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0)
    .execute(input(reservedVramWorkflow(), {}));

  expect(submittedPrompt).toHaveProperty("168.inputs", {
    reserved: 4,
    mode: "auto",
    seed: 492609232740577,
    auto_max_reserved: 0,
    clean_gpu_before: true,
  });
  expect(submittedPrompt).not.toHaveProperty("168.inputs.control_after_generate");
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

function videoWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...audioWorkflow(),
    id: "workflow-video",
    raw: { "2": { class_type: "SaveVideo", inputs: {} } },
    inputMappings: [],
    outputMappings: [{ id: "result", name: "result", nodeId: "2", field: "outputs.videos", mediaType: "video" }],
  };
}

function conditionalWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...audioWorkflow(),
    id: "workflow-conditional",
    raw: {
      "20": { class_type: "ReferenceVisionEncode", inputs: {} },
      "34": { class_type: "LoadImage", inputs: { image: "" } },
      "47": { class_type: "ReferenceVisionEncode", inputs: { image: ["34", 0] } },
      "61": { class_type: "MultiReferenceMerge", inputs: { reference_1: ["20", 0], reference_2: ["47", 0] } },
      "80": { class_type: "SaveImage", inputs: { images: ["61", 0] } },
    },
    nodes: [
      { id: "20", type: "ReferenceVisionEncode", fields: [] },
      { id: "34", type: "LoadImage", title: "参考图 2", fields: [] },
      { id: "47", type: "ReferenceVisionEncode", fields: [] },
      { id: "61", type: "MultiReferenceMerge", fields: [] },
      { id: "80", type: "SaveImage", fields: [] },
    ],
    inputMappings: [{
      id: "reference-2",
      name: "reference_image_2",
      nodeId: "34",
      field: "inputs.image",
      type: "image",
      required: false,
      activation: { when: "provided", nodeIds: ["34", "47"] },
    }],
    outputMappings: [{ id: "result", name: "result", nodeId: "80", field: "outputs.images", mediaType: "image" }],
  };
}

function primitiveWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...imageWorkflow(),
    id: "workflow-primitive",
    raw: {
      nodes: [
        { id: 144, type: "PrimitiveNode", inputs: [], outputs: [{ name: "COMBO", type: "COMBO", links: [273, 274] }], widgets_values: ["16:9", "fixed", ""] },
        { id: 57, type: "ResolutionSelector", inputs: [{ name: "aspect_ratio", type: "COMBO", link: 273 }], outputs: [], widgets_values: ["16:9", 1, 8] },
        { id: 120, type: "ResolutionSelector", inputs: [{ name: "aspect_ratio", type: "COMBO", link: 274 }], outputs: [], widgets_values: ["16:9", 1, 8] },
        { id: 80, type: "SaveImage", inputs: [], outputs: [], widgets_values: ["result"] },
      ],
      links: [
        [273, 144, 0, 57, 0, "COMBO"],
        [274, 144, 0, 120, 0, "COMBO"],
      ],
    },
    nodes: [
      { id: "144", type: "PrimitiveNode", fields: [{ name: "widgets_values.0", kind: "widget", valueType: "string" }, { name: "outputs.COMBO", kind: "output" }] },
      { id: "57", type: "ResolutionSelector", fields: [{ name: "inputs.aspect_ratio", kind: "input" }] },
      { id: "120", type: "ResolutionSelector", fields: [{ name: "inputs.aspect_ratio", kind: "input" }] },
      { id: "80", type: "SaveImage", fields: [{ name: "outputs.images", kind: "output" }] },
    ],
    edges: [
      { id: "273", sourceNodeId: "144", sourceField: "outputs.COMBO", targetNodeId: "57", targetField: "inputs.aspect_ratio" },
      { id: "274", sourceNodeId: "144", sourceField: "outputs.COMBO", targetNodeId: "120", targetField: "inputs.aspect_ratio" },
    ],
    inputMappings: [{ id: "ratio", name: "aspect_ratio", nodeId: "144", field: "widgets_values.0", type: "enum", required: true, enumOptions: ["1:1", "4:3", "16:9"] }],
    outputMappings: [{ id: "result", name: "result", nodeId: "80", field: "outputs.images", mediaType: "image" }],
    nodeMetadata: {
      ResolutionSelector: { fields: { "inputs.aspect_ratio": { comfyType: "COMBO", valueType: "enum", enumOptions: ["1:1", "4:3", "16:9"] } } },
    },
  };
}

function uiWidgetWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...videoWorkflow(),
    id: "workflow-ui-widgets",
    raw: {
      nodes: [
        { id: 20, type: "MarkdownNote", inputs: [], outputs: [], widgets_values: ["说明"] },
        { id: 21, type: "CLIPLoader", inputs: [], outputs: [{ name: "CLIP" }], widgets_values: ["encoder.safetensors", "minimax", "default"] },
        { id: 57, type: "ResolutionSelector", inputs: [], outputs: [{ name: "IMAGE" }], widgets_values: ["16:9", 0.4, 32] },
        { id: 114, type: "RTXVideoSuperResolution", inputs: [{ name: "images", link: 1 }], outputs: [{ name: "IMAGE" }], widgets_values: ["scale by multiplier", 2, "ULTRA"] },
        {
          id: 63,
          type: "VHS_VideoCombine",
          inputs: [{ name: "images", link: 2 }],
          outputs: [],
          widgets_values: {
            frame_rate: 24,
            loop_count: 0,
            filename_prefix: "video/result",
            format: "video/h264-mp4",
            pingpong: false,
            save_output: true,
            videopreview: { paused: false },
          },
        },
      ],
      links: [
        [1, 57, 0, 114, 0, "IMAGE"],
        [2, 114, 0, 63, 0, "IMAGE"],
      ],
    },
    nodes: [
      { id: "20", type: "MarkdownNote", fields: [] },
      { id: "21", type: "CLIPLoader", fields: [] },
      { id: "57", type: "ResolutionSelector", fields: [] },
      { id: "114", type: "RTXVideoSuperResolution", fields: [] },
      { id: "63", type: "VHS_VideoCombine", fields: [] },
    ],
    edges: [
      { id: "1", sourceNodeId: "57", sourceField: "outputs.IMAGE", targetNodeId: "114", targetField: "inputs.images" },
      { id: "2", sourceNodeId: "114", sourceField: "outputs.IMAGE", targetNodeId: "63", targetField: "inputs.images" },
    ],
    inputMappings: [
      { id: "video-mp", name: "video_mp", nodeId: "57", field: "widgets_values.1", type: "double", required: true },
      { id: "upscale-mp", name: "upscale_mp", nodeId: "114", field: "widgets_values.1", type: "double", required: true },
    ],
    outputMappings: [{ id: "result", name: "result", nodeId: "63", field: "outputs.videos", mediaType: "video" }],
    nodeMetadata: {
      CLIPLoader: {
        fields: {},
        widgetInputs: [{ name: "clip_name" }, { name: "type" }, { name: "device" }],
      },
      ResolutionSelector: {
        fields: { "inputs.megapixels": { comfyType: "FLOAT", valueType: "double" } },
        widgetInputs: [{ name: "aspect_ratio" }, { name: "megapixels" }, { name: "multiple" }],
      },
      RTXVideoSuperResolution: {
        fields: { "inputs.resize_type.scale": { comfyType: "FLOAT", valueType: "double" } },
        widgetInputs: [
          { name: "resize_type", dynamicOptions: { "scale by multiplier": ["scale"], "target dimensions": ["width", "height"] } },
          { name: "quality" },
        ],
      },
      VHS_VideoCombine: { fields: {} },
    },
  };
}

function reservedVramWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...imageWorkflow(),
    id: "workflow-reserved-vram",
    raw: {
      nodes: [
        {
          id: 168,
          type: "ReservedVRAMSetter",
          inputs: [],
          outputs: [{ name: "output", type: "*", links: [1] }],
          widgets_values: [4, "auto", 492609232740577, "randomize", 0, true],
          widgets_values_named: {
            reserved: 4,
            mode: "auto",
            seed: 492609232740577,
            control_after_generate: "randomize",
            auto_max_reserved: 0,
            clean_gpu_before: true,
          },
        },
        { id: 80, type: "SaveImage", inputs: [{ name: "images", type: "*", link: 1 }], outputs: [] },
      ],
      links: [[1, 168, 0, 80, 0, "*"]],
    },
    nodes: [
      { id: "168", type: "ReservedVRAMSetter", fields: [] },
      { id: "80", type: "SaveImage", fields: [] },
    ],
    edges: [{ id: "1", sourceNodeId: "168", sourceField: "outputs.output", targetNodeId: "80", targetField: "inputs.images" }],
    outputMappings: [{ id: "result", name: "result", nodeId: "80", field: "outputs.images", mediaType: "image" }],
    nodeMetadata: {
      ReservedVRAMSetter: {
        fields: {
          "inputs.reserved": { comfyType: "FLOAT", valueType: "double" },
          "inputs.mode": { comfyType: "COMBO", valueType: "enum" },
          "inputs.seed": { comfyType: "INT", valueType: "int" },
          "inputs.auto_max_reserved": { comfyType: "FLOAT", valueType: "double" },
          "inputs.clean_gpu_before": { comfyType: "BOOLEAN", valueType: "bool" },
        },
        widgetInputs: [
          { name: "reserved" },
          { name: "mode" },
          { name: "seed" },
          { name: "auto_max_reserved" },
          { name: "clean_gpu_before" },
        ],
      },
    },
  };
}

function bypassWorkflow(): AigcWorkflowDetail & { raw: unknown } {
  return {
    ...imageWorkflow(),
    id: "workflow-bypass",
    raw: {
      nodes: [
        { id: 1, type: "LoadImage", inputs: [], outputs: [{ name: "IMAGE", type: "IMAGE", links: [1] }], widgets_values: ["input.png"] },
        { id: 2, type: "ImagePassThrough", mode: 4, inputs: [{ name: "image", type: "IMAGE", link: 1 }], outputs: [{ name: "IMAGE", type: "IMAGE", links: [2] }] },
        { id: 4, type: "SaveImage", inputs: [{ name: "images", type: "IMAGE", link: 2 }], outputs: [], widgets_values: ["result"] },
        { id: 5, type: "LoadVideo", mode: 4, inputs: [], outputs: [{ name: "VIDEO", type: "VIDEO", links: [3] }], widgets_values: ["sample.mp4"] },
        { id: 6, type: "GetVideoComponents", mode: 4, inputs: [{ name: "video", type: "VIDEO", link: 3 }], outputs: [{ name: "images", type: "IMAGE", links: [4] }, { name: "audio", type: "AUDIO", links: [5] }] },
        { id: 7, type: "ReferenceInputs", inputs: [{ name: "reference_image", type: "IMAGE", link: 4 }, { name: "reference_audio", type: "AUDIO", link: 5 }], outputs: [] },
      ],
      links: [
        [1, 1, 0, 2, 0, "IMAGE"],
        [2, 2, 0, 4, 0, "IMAGE"],
        [3, 5, 0, 6, 0, "VIDEO"],
        [4, 6, 0, 7, 0, "IMAGE"],
        [5, 6, 1, 7, 1, "AUDIO"],
      ],
    },
    nodes: [
      { id: "1", type: "LoadImage", fields: [] },
      { id: "2", type: "ImagePassThrough", fields: [] },
      { id: "4", type: "SaveImage", fields: [] },
      { id: "5", type: "LoadVideo", fields: [] },
      { id: "6", type: "GetVideoComponents", fields: [] },
      { id: "7", type: "ReferenceInputs", fields: [] },
    ],
    edges: [],
    inputMappings: [],
    outputMappings: [{ id: "result", name: "result", nodeId: "4", field: "outputs.images", mediaType: "image" }],
    nodeMetadata: {
      LoadImage: { fields: {}, widgetInputs: [{ name: "image" }] },
      SaveImage: { fields: {}, widgetInputs: [{ name: "filename_prefix" }] },
      LoadVideo: { fields: {}, widgetInputs: [{ name: "file" }] },
    },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
