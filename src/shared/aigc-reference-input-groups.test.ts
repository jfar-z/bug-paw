import { describe, expect, it } from "vitest";

import type { AigcWorkflowDetail, ComfyUiEdge, ComfyUiNode } from "./aigc-contracts";
import { commonReferenceInputFields, referenceInputFamilies, traceReferenceInputBranches } from "./aigc-reference-input-groups";

/** 构造与 Remove Background 相同的图片汇总拓扑。 */
function imageBatchWorkflow(boundaryType = "ImpactMakeImageBatch"): AigcWorkflowDetail {
  const nodes: ComfyUiNode[] = Array.from({ length: 8 }, (_, index) => ({
    id: String(index + 1),
    type: "LoadImage",
    fields: [
      { name: "widgets_values.0", kind: "widget" },
      { name: "widgets_values.1", kind: "widget" },
      { name: "outputs.IMAGE", kind: "output" },
    ],
  }));
  nodes.push({
    id: "25",
    type: boundaryType,
    fields: Array.from({ length: 9 }, (_, index) => ({ name: `inputs.image${index + 1}`, kind: "input" as const })),
  });
  const edges: ComfyUiEdge[] = nodes.slice(0, 8).map((node, index) => ({
    id: String(index + 1),
    sourceNodeId: node.id,
    sourceField: "outputs.IMAGE",
    targetNodeId: "25",
    targetField: `inputs.image${index + 1}`,
  }));
  return {
    id: "workflow",
    name: "Remove Background",
    fileName: "workflow.json",
    originalHash: "hash",
    nodes,
    edges,
    inputMappings: [],
    outputMappings: [],
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
}

describe("AIGC 参考输入组", () => {
  it("将 ImpactMakeImageBatch 已连接的编号图片槽位组成一个有序参考组", () => {
    const workflow = imageBatchWorkflow();
    const families = referenceInputFamilies(workflow, "25");
    expect(families).toEqual([{
      prefix: "inputs.image",
      targetFields: Array.from({ length: 8 }, (_, index) => `inputs.image${index + 1}`),
    }]);

    const branches = traceReferenceInputBranches(workflow, "25", families[0].prefix);
    expect(branches.map((branch) => branch.rootNodeId)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(commonReferenceInputFields(workflow, branches)).toEqual(["widgets_values.0", "widgets_values.1"]);
  });

  it("保持其他节点的扁平编号输入独立", () => {
    const workflow = imageBatchWorkflow("OtherImageBatch");
    expect(referenceInputFamilies(workflow, "25").map((family) => family.prefix))
      .toEqual(Array.from({ length: 8 }, (_, index) => `inputs.image${index + 1}`));
  });
});
