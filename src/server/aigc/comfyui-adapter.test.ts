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

  it("视频节点实际写入 images 桶时仍可按视频类型下载", async () => {
    const request = vi.fn(async (requestInput: string | URL | Request) => {
      const url = String(requestInput);
      if (url.endsWith("/prompt")) return json({ prompt_id: "prompt-video" });
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-video"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-video")) {
        return json({ "prompt-video": { outputs: { "2": { images: [{ filename: "result.mp4", subfolder: "video\\temp", type: "output" }], animated: [true] } } } });
      }
      if (url.includes("/view?")) return new Response(Buffer.from("video"), { status: 200, headers: { "Content-Type": "video/mp4" } });
      throw new Error(`未处理请求 ${url}`);
    });
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    const result = await adapter.execute(input(videoWorkflow(), {}));

    expect(result.assets).toEqual([{ name: "result.mp4", mediaType: "video/mp4", content: Buffer.from("video") }]);
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

  it("条件参数缺失时裁剪节点组及组外输入引用", async () => {
    let submittedPrompt: Record<string, unknown> | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
        return json({ prompt_id: "prompt-conditional" });
      }
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-conditional"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-conditional")) return json({ "prompt-conditional": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await adapter.execute(input(conditionalWorkflow(), {}));

    expect(submittedPrompt).not.toHaveProperty("34");
    expect(submittedPrompt).not.toHaveProperty("47");
    expect(submittedPrompt).toHaveProperty("61");
    expect(submittedPrompt).not.toHaveProperty("61.inputs.reference_2");
    expect(submittedPrompt).toHaveProperty("61.inputs.reference_1", ["20", 0]);
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

    await adapter.execute(execution);

    expect(execution.assets.resolveInputPath).toHaveBeenCalledWith("asset-reference-2");
    expect(submittedPrompt).toHaveProperty("34.inputs.image", "reference-2.png");
    expect(submittedPrompt).toHaveProperty("47.inputs.image", ["34", 0]);
  });

  it("公开目录媒体入参先解析 BugPaw 文件再上传到 ComfyUI", async () => {
    let uploadedForm: FormData | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/upload/image")) {
        uploadedForm = init?.body as FormData;
        return json({ name: "public-upload.png" });
      }
      if (url.endsWith("/prompt")) return json({ prompt_id: "prompt-public" });
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-public"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-public")) return json({ "prompt-public": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const execution = input(conditionalWorkflow(), {
      reference_image_2: { assetId: "public-file", name: "公开参考.png", mediaType: "image/png", source: "public" },
    });
    execution.publicFiles = { resolvePath: vi.fn(async () => "/etc/hostname") } as unknown as AigcExecutionInput["publicFiles"];
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await adapter.execute(execution);

    expect(execution.publicFiles!.resolvePath).toHaveBeenCalledWith("public-file");
    expect(execution.assets.resolveInputPath).not.toHaveBeenCalled();
    expect((uploadedForm?.get("image") as File).name).toBe("公开参考.png");
  });

  it("选择 ComfyUI input 文件时直接写入文件名而不重复上传", async () => {
    let submittedPrompt: Record<string, unknown> | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/upload/image")) throw new Error("ComfyUI input 文件不应重复上传");
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
        return json({ prompt_id: "prompt-comfy-input" });
      }
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-comfy-input"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-comfy-input")) return json({ "prompt-comfy-input": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const execution = input(conditionalWorkflow(), {
      reference_image_2: { filename: "existing-input.png", name: "existing-input.png", mediaType: "image/png", source: "comfyui_input" },
    });
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await adapter.execute(execution);

    expect(execution.assets.resolveInputPath).not.toHaveBeenCalled();
    expect(submittedPrompt).toHaveProperty("34.inputs.image", "existing-input.png");
  });

  it("提交 Prompt 前拒绝超出节点元数据范围的运行值", async () => {
    const workflow: AigcWorkflowDetail & { raw: unknown } = {
      ...imageWorkflow(),
      raw: { "1": { class_type: "KSampler", inputs: { cfg: 8 } }, "2": { class_type: "SaveImage", inputs: {} } },
      nodes: [{ id: "1", type: "KSampler", fields: [] }, { id: "2", type: "SaveImage", fields: [] }],
      inputMappings: [{ id: "cfg", name: "cfg", nodeId: "1", field: "inputs.cfg", type: "double", required: true }],
      nodeMetadata: { KSampler: { fields: { "inputs.cfg": { comfyType: "FLOAT", valueType: "double", min: 0, max: 20 } } } },
    };
    const request = vi.fn();
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await expect(adapter.execute(input(workflow, { cfg: 21 }))).rejects.toThrow("不能大于 20");
    expect(request).not.toHaveBeenCalled();
  });

  it("展开 UI 工作流 Primitive 并把映射值写入全部下游", async () => {
    let submittedPrompt: Record<string, unknown> | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
        return json({ prompt_id: "prompt-primitive" });
      }
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-primitive"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-primitive")) return json({ "prompt-primitive": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await adapter.execute(input(primitiveWorkflow(), { aspect_ratio: "4:3" }));

    expect(submittedPrompt).not.toHaveProperty("144");
    expect(submittedPrompt).toHaveProperty("57.inputs.aspect_ratio", "4:3");
    expect(submittedPrompt).toHaveProperty("120.inputs.aspect_ratio", "4:3");
  });

  it("未映射 Primitive 时仍把工作流默认值展开到下游", async () => {
    let submittedPrompt: Record<string, unknown> | undefined;
    const request = vi.fn(async (requestInput: string | URL | Request, init?: RequestInit) => {
      const url = String(requestInput);
      if (url.endsWith("/prompt")) {
        submittedPrompt = (JSON.parse(String(init?.body)) as { prompt: Record<string, unknown> }).prompt;
        return json({ prompt_id: "prompt-primitive-default" });
      }
      if (url.endsWith("/queue")) return json({ queue_running: [[1, "prompt-primitive-default"]], queue_pending: [] });
      if (url.endsWith("/history/prompt-primitive-default")) return json({ "prompt-primitive-default": { outputs: { "80": { images: [{ filename: "result.png" }] } } } });
      if (url.includes("/view?")) return new Response(Buffer.from("png"), { status: 200 });
      throw new Error(`未处理请求 ${url}`);
    });
    const workflow = primitiveWorkflow();
    workflow.inputMappings = [];
    const adapter = new ComfyUiAigcAdapter(request as unknown as typeof fetch, () => undefined, 0);

    await adapter.execute(input(workflow, {}));

    expect(submittedPrompt).not.toHaveProperty("144");
    expect(submittedPrompt).toHaveProperty("57.inputs.aspect_ratio", "16:9");
    expect(submittedPrompt).toHaveProperty("120.inputs.aspect_ratio", "16:9");
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

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
