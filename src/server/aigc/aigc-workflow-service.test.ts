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

/** 多参考条件分支测试工作流。 */
function conditionalWorkflow() {
  return {
    "34": { class_type: "LoadImage", inputs: { image: "" } },
    "47": { class_type: "ReferenceVisionEncode", inputs: { image: ["34", 0] } },
    "61": { class_type: "MultiReferenceMerge", inputs: { reference_2: ["47", 0] } },
  };
}
