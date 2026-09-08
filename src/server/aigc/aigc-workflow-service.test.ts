import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { AigcWorkflowService } from "./aigc-workflow-service";

describe("AIGC 工作流服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "aigc-workflows-"));
    roots.push(root);
    return new AigcWorkflowService(join(root, "workflows.json"));
  }

  it("导入 API 工作流并保存字段映射", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "文生图",
      fileName: "txt2img.json",
      workflowJson: {
        "1": { class_type: "KSampler", inputs: { steps: 20, seed: 1 } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      },
      inputMappings: [
        { id: "steps", name: "steps", nodeId: "1", field: "inputs.steps", type: "int", required: true },
      ],
      outputMappings: [
        { id: "image", name: "image", nodeId: "2", field: "outputs.images", mediaType: "image" },
      ],
    });

    expect(created.workflow.nodes).toHaveLength(2);
    expect(created.workflow.edges).toHaveLength(1);
    expect(created.workflow.inputMappings).toEqual([expect.objectContaining({ name: "steps", type: "int" })]);
    expect(created.workflow.outputMappings).toEqual([expect.objectContaining({ name: "image", mediaType: "image" })]);
    expect((await service.list()).workflows).toHaveLength(1);
  });

  it("同步节点定义后将媒体控件索引迁移为稳定字段并隐藏预览状态", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "视频拼接",
      fileName: "video.json",
      workflowJson: {
        nodes: [{
          id: 19,
          type: "LoadVideo",
          inputs: [],
          outputs: [{ name: "VIDEO", type: "VIDEO" }],
          widgets_values: ["default.mp4", "image"],
        }],
        links: [],
      },
      inputMappings: [{ id: "video", name: "video", nodeId: "19", field: "widgets_values.0", type: "video", required: true }],
      outputMappings: [],
    });

    expect(created.workflow.inputMappings[0].field).toBe("widgets_values.0");

    const synced = await service.syncNodeMetadata(created.workflow.id, {
      LoadVideo: {
        fields: { "inputs.file": { comfyType: "VIDEO", valueType: "video", required: true } },
        widgetInputs: [{ name: "file" }],
      },
    }, "2026-09-08T08:00:00.000Z", created.revision);

    expect(synced.workflow.inputMappings).toEqual([expect.objectContaining({ field: "inputs.file", type: "video" })]);
    expect(synced.workflow.nodes[0].fields).toEqual([
      expect.objectContaining({ name: "outputs.VIDEO", kind: "output" }),
      expect.objectContaining({ name: "inputs.file", kind: "input", valueType: "video" }),
    ]);
    expect(synced.workflow.nodes[0].fields).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "widgets_values.1" }),
    ]));
  });

  it("替换原始工作流时保留标识、映射和节点元数据", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "文生图",
      fileName: "old.json",
      workflowJson: {
        "1": { class_type: "KSampler", inputs: { steps: 20, seed: 1 } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      },
      inputMappings: [{ id: "steps", name: "steps", nodeId: "1", field: "inputs.steps", type: "int", required: true }],
      outputMappings: [{ id: "image", name: "image", nodeId: "2", field: "outputs.images", mediaType: "image" }],
    });
    const synced = await service.syncNodeMetadata(created.workflow.id, {
      KSampler: { fields: { "inputs.steps": { comfyType: "INT", valueType: "int", required: true } } },
    }, "2026-09-08T08:00:00.000Z", created.revision);

    const replaced = await service.replace(created.workflow.id, {
      fileName: "new.json",
      workflowJson: {
        "1": { class_type: "KSampler", inputs: { steps: 30, seed: 2, cfg: 7 } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "BugPaw" } },
      },
    }, synced.revision);

    expect(replaced.workflow).toMatchObject({
      id: created.workflow.id,
      name: "文生图",
      fileName: "new.json",
      inputMappings: created.workflow.inputMappings,
      outputMappings: created.workflow.outputMappings,
      nodeMetadataSyncedAt: "2026-09-08T08:00:00.000Z",
    });
    expect(replaced.workflow.originalHash).not.toBe(created.workflow.originalHash);
    expect((await service.getPrivate(created.workflow.id))?.raw).toMatchObject({
      "1": { inputs: { steps: 30, cfg: 7 } },
    });
  });

  it("新工作流缺少已映射字段时拒绝替换且不修改原记录", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "文生图",
      fileName: "old.json",
      workflowJson: { "1": { class_type: "KSampler", inputs: { steps: 20 } } },
      inputMappings: [{ id: "steps", name: "steps", nodeId: "1", field: "inputs.steps", type: "int", required: true }],
      outputMappings: [],
    });

    await expect(service.replace(created.workflow.id, {
      fileName: "incompatible.json",
      workflowJson: { "1": { class_type: "KSampler", inputs: { seed: 1 } } },
    }, created.revision)).rejects.toThrow("无法保留入参“steps”：节点 1 缺少字段 inputs.steps");

    const current = await service.get(created.workflow.id);
    expect(current.workflow).toMatchObject({ fileName: "old.json", originalHash: created.workflow.originalHash });
  });

});

function primitiveUiWorkflow() {
  return {
    nodes: [
      {
        id: 144,
        type: "PrimitiveNode",
        inputs: [],
        outputs: [{ name: "COMBO", type: "COMBO", links: [273, 274] }],
        widgets_values: ["16:9", "fixed", ""],
      },
      { id: 57, type: "ResolutionSelector", inputs: [{ name: "aspect_ratio", type: "COMBO", link: 273 }], outputs: [], widgets_values: ["16:9", 1, 8] },
      { id: 120, type: "ResolutionSelector", inputs: [{ name: "aspect_ratio", type: "COMBO", link: 274 }], outputs: [], widgets_values: ["16:9", 1, 8] },
    ],
    links: [
      [273, 144, 0, 57, 0, "COMBO"],
      [274, 144, 0, 120, 0, "COMBO"],
    ],
  };
}

/** 多参考条件分支测试工作流。 */
function conditionalWorkflow() {
  return {
    "34": { class_type: "LoadImage", inputs: { image: "" } },
    "47": { class_type: "ReferenceVisionEncode", inputs: { image: ["34", 0] } },
    "61": { class_type: "MultiReferenceMerge", inputs: { reference_2: ["47", 0] } },
  };
}
