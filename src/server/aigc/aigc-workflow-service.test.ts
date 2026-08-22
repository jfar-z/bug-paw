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

  it("拒绝引用不存在节点或超限文件", async () => {
    const service = await fixture();
    await expect(service.create({
      name: "错误映射",
      fileName: "bad.json",
      workflowJson: { "1": { class_type: "EmptyLatentImage", inputs: {} } },
      inputMappings: [{ id: "bad", name: "bad", nodeId: "missing", field: "inputs.width", type: "int", required: true }],
      outputMappings: [],
    })).rejects.toThrow("不存在的节点");

    await expect(service.create({
      name: "超大文件",
      fileName: "huge.json",
      workflowJson: { padding: "x".repeat(4 * 1024 * 1024 + 1) },
      inputMappings: [],
      outputMappings: [],
    })).rejects.toThrow("不能超过 4 MiB");
  });

  it("更新映射但保留原始 hash", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "视频",
      fileName: "video.json",
      workflowJson: { "1": { class_type: "VHS_VideoCombine", inputs: { images: ["2", 0] } } },
      inputMappings: [],
      outputMappings: [],
    });
    const updated = await service.update(created.workflow.id, {
      name: "视频生成",
      inputMappings: [{ id: "prompt", name: "prompt", nodeId: "1", field: "inputs.images", type: "image", required: true }],
      outputMappings: [{ id: "video", name: "video", nodeId: "1", field: "outputs.videos", mediaType: "video" }],
    }, created.revision);

    expect(updated.workflow.name).toBe("视频生成");
    expect(updated.workflow.originalHash).toBe(created.workflow.originalHash);
    expect(updated.workflow.inputMappings[0].type).toBe("image");
  });

  it("合并节点元数据并校验映射默认值范围和数值枚举", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "采样工作流",
      fileName: "sampler.json",
      workflowJson: { "1": { class_type: "KSampler", inputs: { cfg: 0, sampler: 2 } } },
      inputMappings: [],
      outputMappings: [],
    });
    const synced = await service.syncNodeMetadata(created.workflow.id, {
      KSampler: {
        fields: {
          "inputs.cfg": { comfyType: "FLOAT", valueType: "double", min: 0, max: 20 },
          "inputs.sampler": { comfyType: "COMBO", valueType: "enum", enumOptions: [1, 2, 3] },
        },
      },
    }, "2026-08-20T08:00:00.000Z", created.revision);

    expect(synced.workflow.nodeMetadataSyncedAt).toBe("2026-08-20T08:00:00.000Z");
    await expect(service.update(created.workflow.id, {
      name: "采样工作流",
      inputMappings: [{ id: "cfg", name: "cfg", nodeId: "1", field: "inputs.cfg", type: "double", required: false, defaultValue: 21 }],
      outputMappings: [],
    }, synced.revision)).rejects.toThrow("不能大于 20");

    const updated = await service.update(created.workflow.id, {
      name: "采样工作流",
      inputMappings: [{ id: "sampler", name: "sampler", nodeId: "1", field: "inputs.sampler", type: "enum", required: true, enumOptions: [1, 2, 3], defaultValue: 2 }],
      outputMappings: [],
    }, synced.revision);
    expect(updated.workflow.inputMappings[0]).toMatchObject({ enumOptions: [1, 2, 3], defaultValue: 2 });
  });

  it("同步后按 Primitive 实例推导枚举并允许保存 widget 映射", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "动态宽高比",
      fileName: "primitive.json",
      workflowJson: primitiveUiWorkflow(),
      inputMappings: [],
      outputMappings: [],
    });
    const synced = await service.syncNodeMetadata(created.workflow.id, {
      ResolutionSelector: {
        fields: {
          "inputs.aspect_ratio": { comfyType: "COMBO", valueType: "enum", enumOptions: ["1:1", "16:9"] },
        },
        widgetInputs: [{
          name: "aspect_ratio",
          dynamicOptions: { custom: ["width", "height"] },
        }],
      },
    }, "2026-08-21T08:00:00.000Z", created.revision);

    expect(synced.workflow.resolvedFieldMetadata?.["144"]?.["widgets_values.0"]).toMatchObject({
      valueType: "enum",
      enumOptions: ["1:1", "16:9"],
      source: "inferred",
    });
    const reloaded = await service.get(created.workflow.id);
    expect(reloaded.workflow.nodeMetadata?.ResolutionSelector.widgetInputs).toEqual([{
      name: "aspect_ratio",
      dynamicOptions: { custom: ["width", "height"] },
    }]);
    const updated = await service.update(created.workflow.id, {
      name: "动态宽高比",
      inputMappings: [{
        id: "ratio",
        name: "aspect_ratio",
        nodeId: "144",
        field: "widgets_values.0",
        type: "enum",
        required: true,
        enumOptions: ["1:1", "16:9"],
        defaultValue: "16:9",
      }],
      outputMappings: [],
    }, synced.revision);

    expect(updated.workflow.inputMappings[0]).toMatchObject({ type: "enum", defaultValue: "16:9" });
  });

  it("保存音频输入和输出映射", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "音频处理",
      fileName: "audio.json",
      workflowJson: {
        "1": { class_type: "LoadAudio", inputs: { audio: "input.wav" } },
        "2": { class_type: "SaveAudio", inputs: { audio: ["1", 0] } },
      },
      inputMappings: [{ id: "audio", name: "audio", nodeId: "1", field: "inputs.audio", type: "audio", required: true }],
      outputMappings: [{ id: "result", name: "result", nodeId: "2", field: "outputs.audio", mediaType: "audio" }],
    });

    expect(created.workflow.inputMappings[0]).toMatchObject({ type: "audio" });
    expect(created.workflow.outputMappings[0]).toMatchObject({ mediaType: "audio" });
  });

  it("保存参数有值时启用的条件节点组", async () => {
    const service = await fixture();
    const created = await service.create({
      name: "多参考生视频",
      fileName: "multi-reference.json",
      workflowJson: conditionalWorkflow(),
      inputMappings: [{
        id: "reference-2",
        name: "reference_image_2",
        nodeId: "34",
        field: "inputs.image",
        type: "image",
        required: false,
        activation: { when: "provided", nodeIds: ["34", "47"] },
      }],
      outputMappings: [],
    });

    expect(created.workflow.inputMappings[0].activation).toEqual({ when: "provided", nodeIds: ["34", "47"] });
  });

  it("保存参考输入组并校验成员类型与连续顺序", async () => {
    const service = await fixture();
    const inputMappings = [
      { id: "first", name: "reference_1", nodeId: "34", field: "inputs.image", type: "image" as const, required: false, activation: { when: "provided" as const, nodeIds: ["34"] } },
      { id: "second", name: "reference_2", nodeId: "47", field: "inputs.image", type: "image" as const, required: false, activation: { when: "provided" as const, nodeIds: ["47"] } },
    ];
    const created = await service.create({
      name: "参考组",
      fileName: "reference-group.json",
      workflowJson: conditionalWorkflow(),
      inputMappings,
      inputGroups: [{ id: "images", label: "参考图片", type: "image", mappingIds: ["first", "second"], boundaryNodeId: "61", targetFieldPrefix: "inputs.references" }],
      outputMappings: [],
    });

    expect(created.workflow.inputGroups).toEqual([expect.objectContaining({ id: "images", mappingIds: ["first", "second"] })]);
    const loaded = await service.get(created.workflow.id);
    expect(loaded.workflow.inputGroups?.[0].label).toBe("参考图片");

    await expect(service.update(created.workflow.id, {
      name: "参考组",
      inputMappings: [inputMappings[0], { id: "prompt", name: "prompt", nodeId: "61", field: "inputs.prompt", type: "string", required: true }, inputMappings[1]],
      inputGroups: created.workflow.inputGroups,
      outputMappings: [],
    }, created.revision)).rejects.toThrow("连续排列");
  });

  it("拒绝无效或交叉的条件节点组", async () => {
    const service = await fixture();
    const base = {
      name: "条件工作流",
      fileName: "conditional.json",
      workflowJson: conditionalWorkflow(),
      outputMappings: [],
    };
    await expect(service.create({
      ...base,
      inputMappings: [{ id: "required", name: "required", nodeId: "34", field: "inputs.image", type: "image" as const, required: true, activation: { when: "provided" as const, nodeIds: ["34"] } }],
    })).rejects.toThrow("只能绑定可选入参");
    await expect(service.create({
      ...base,
      inputMappings: [{ id: "missing-target", name: "missing_target", nodeId: "34", field: "inputs.image", type: "image" as const, required: false, activation: { when: "provided" as const, nodeIds: ["47"] } }],
    })).rejects.toThrow("必须包含入参映射节点");
    await expect(service.create({
      ...base,
      inputMappings: [{ id: "missing-node", name: "missing_node", nodeId: "34", field: "inputs.image", type: "image" as const, required: false, activation: { when: "provided" as const, nodeIds: ["34", "999"] } }],
    })).rejects.toThrow("不存在的节点");
    await expect(service.create({
      ...base,
      inputMappings: [
        { id: "first", name: "first", nodeId: "34", field: "inputs.image", type: "image" as const, required: false, activation: { when: "provided" as const, nodeIds: ["34", "47"] } },
        { id: "second", name: "second", nodeId: "47", field: "inputs.image", type: "image" as const, required: false, activation: { when: "provided" as const, nodeIds: ["47"] } },
      ],
    })).rejects.toThrow("不能包含重复节点");
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
