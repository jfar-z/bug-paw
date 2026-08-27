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
