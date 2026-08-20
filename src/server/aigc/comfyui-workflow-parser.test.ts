import { describe, expect, it } from "vitest";

import { ComfyUiWorkflowParser } from "./comfyui-workflow-parser";

describe("ComfyUI 工作流解析", () => {
  const parser = new ComfyUiWorkflowParser();

  it("解析 UI 导出格式的节点、连线和稳定 hash", () => {
    const raw = {
      nodes: [
        {
          id: 1,
          type: "KSampler",
          inputs: [{ name: "model", type: "MODEL", link: 1 }],
          outputs: [{ name: "LATENT", type: "LATENT", links: [2] }],
          widgets_values: [123, 20, 8],
        },
        {
          id: 2,
          type: "SaveImage",
          inputs: [{ name: "images", type: "IMAGE", link: 2 }],
          outputs: [],
          widgets_values: ["result"],
        },
      ],
      links: [[1, 1, 0, 2, 0, "LATENT"]],
    };

    const parsed = parser.parse(raw);

    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0].fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "inputs.model", kind: "input" }),
      expect.objectContaining({ name: "widgets_values.0", valueType: "int" }),
    ]));
    expect(parsed.edges).toEqual([expect.objectContaining({
      sourceNodeId: "1",
      sourceField: "outputs.LATENT",
      targetNodeId: "2",
      targetField: "inputs.images",
    })]);
    expect(parsed.originalHash).toHaveLength(64);
  });

  it("解析 API 格式的节点并识别连线", () => {
    const raw = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
      "2": { class_type: "KSampler", inputs: { model: ["1", 0], steps: 20, seed: 123 } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    };

    const parsed = parser.parse(raw);

    expect(parsed.nodes.map((node) => node.type)).toEqual(["CheckpointLoaderSimple", "KSampler", "SaveImage"]);
    expect(parsed.edges).toHaveLength(2);
    expect(parsed.nodes[2].fields).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "outputs.images", kind: "output" }),
    ]));
  });

  it("拒绝畸形或无法识别的 JSON", () => {
    expect(() => parser.parse([])).toThrow("必须是 JSON 对象");
    expect(() => parser.parse({})).toThrow("无法识别");
  });

  it("识别常见音频保存节点的输出字段", () => {
    const parsed = parser.parse({
      "1": { class_type: "LoadAudio", inputs: { audio: "input.wav" } },
      "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } },
    });

    expect(parsed.nodes[1].fields).toContainEqual(expect.objectContaining({ name: "outputs.audio", kind: "output" }));
  });
});
