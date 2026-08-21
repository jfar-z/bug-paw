import { describe, expect, it } from "vitest";

import type { ComfyUiNodeMetadata } from "./aigc-contracts";
import { resolveWorkflowFieldMetadata } from "./aigc-workflow-field-metadata";

describe("ComfyUI 工作流字段元数据解析", () => {
  it("从 Primitive 的全部下游枚举字段推导共同候选值", () => {
    const resolved = resolveWorkflowFieldMetadata(fixture({
      FirstSelector: enumMetadata(["1:1", "4:3", "16:9"]),
      SecondSelector: enumMetadata(["4:3", "16:9", "21:9"]),
    }));

    expect(resolved["144"]["widgets_values.0"]).toEqual(expect.objectContaining({
      comfyType: "COMBO",
      valueType: "enum",
      enumOptions: ["4:3", "16:9"],
      source: "inferred",
      inferredFrom: [
        { nodeId: "57", field: "inputs.aspect_ratio" },
        { nodeId: "120", field: "inputs.aspect_ratio" },
      ],
    }));
  });

  it("下游字段类型冲突时保留实例级冲突而不猜测", () => {
    const resolved = resolveWorkflowFieldMetadata(fixture({
      FirstSelector: enumMetadata(["16:9"]),
      SecondSelector: { fields: { "inputs.aspect_ratio": { comfyType: "INT", valueType: "int" } } },
    }));

    expect(resolved["144"]["widgets_values.0"]).toMatchObject({
      valueType: "string",
      source: "inferred",
      conflict: "下游字段类型不兼容：enum、int",
    });
  });

  it("未知目标缺少节点定义时只保留工作流字面类型", () => {
    const source = fixture({ FirstSelector: enumMetadata(["16:9"]) });
    const resolved = resolveWorkflowFieldMetadata(source);

    expect(resolved["144"]["widgets_values.0"]).toEqual({
      comfyType: "STRING",
      valueType: "string",
      source: "workflow",
    });
  });
});

function fixture(nodeMetadata: ComfyUiNodeMetadata) {
  return {
    nodes: [
      {
        id: "144",
        type: "PrimitiveNode",
        fields: [
          { name: "outputs.COMBO", kind: "output" as const },
          { name: "widgets_values.0", kind: "widget" as const, valueType: "string" as const },
        ],
      },
      { id: "57", type: "FirstSelector", fields: [{ name: "inputs.aspect_ratio", kind: "input" as const }] },
      { id: "120", type: "SecondSelector", fields: [{ name: "inputs.aspect_ratio", kind: "input" as const }] },
    ],
    edges: [
      { id: "273", sourceNodeId: "144", sourceField: "outputs.COMBO", targetNodeId: "57", targetField: "inputs.aspect_ratio" },
      { id: "274", sourceNodeId: "144", sourceField: "outputs.COMBO", targetNodeId: "120", targetField: "inputs.aspect_ratio" },
    ],
    nodeMetadata,
  };
}

function enumMetadata(options: string[]): ComfyUiNodeMetadata[string] {
  return { fields: { "inputs.aspect_ratio": { comfyType: "COMBO", valueType: "enum", enumOptions: options } } };
}
