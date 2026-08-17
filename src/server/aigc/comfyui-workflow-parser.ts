import { createHash } from "node:crypto";

import type {
  AigcWorkflowInputType,
  ComfyUiEdge,
  ComfyUiField,
  ComfyUiNode,
} from "../../shared/aigc-contracts";

export interface ParsedComfyUiWorkflow {
  nodes: ComfyUiNode[];
  edges: ComfyUiEdge[];
  originalHash: string;
}

/** 解析 ComfyUI 的 UI 导出格式与 API 格式，但绝不执行节点脚本。 */
export class ComfyUiWorkflowParser {
  /** 解析工作流并返回稳定 hash、节点和连线。 */
  parse(raw: unknown): ParsedComfyUiWorkflow {
    if (!isRecord(raw)) throw new TypeError("ComfyUI 工作流必须是 JSON 对象");
    const originalHash = createHash("sha256").update(canonicalJson(raw)).digest("hex");
    if (Array.isArray(raw.nodes) && Array.isArray(raw.links)) {
      return { ...this.parseUiFormat(raw), originalHash };
    }
    if (Object.values(raw).some((node) => isRecord(node) && typeof node.class_type === "string")) {
      return { ...this.parseApiFormat(raw), originalHash };
    }
    throw new TypeError("无法识别 ComfyUI 工作流格式");
  }

  /** 解析浏览器保存按钮导出的 UI 格式。 */
  private parseUiFormat(raw: Record<string, unknown>): Omit<ParsedComfyUiWorkflow, "originalHash"> {
    const nodeRecords = (raw.nodes as unknown[]).map((node, index) => {
      if (!isRecord(node)) throw new TypeError(`工作流节点 ${index + 1} 格式无效`);
      return node;
    });
    const nodesById = new Map<string, Record<string, unknown>>();
    const nodes = nodeRecords.map((node) => {
      const id = String(node.id);
      if (!id) throw new TypeError("工作流节点缺少 ID");
      nodesById.set(id, node);
      return this.nodeFromUiRecord(id, node);
    });

    const edges = (raw.links as unknown[]).flatMap((link, index) => {
      if (!Array.isArray(link) || link.length < 5) throw new TypeError(`工作流连线 ${index + 1} 格式无效`);
      const [id, sourceNodeId, sourceSlot, targetNodeId, targetSlot] = link;
      const source = nodesById.get(String(sourceNodeId));
      const target = nodesById.get(String(targetNodeId));
      return [{
        id: String(id ?? index),
        sourceNodeId: String(sourceNodeId),
        sourceField: sourceFieldFromUiNode(source, Number(sourceSlot)),
        targetNodeId: String(targetNodeId),
        targetField: targetFieldFromUiNode(target, Number(targetSlot)),
      }];
    });
    return { nodes, edges };
  }

  /** 解析 API 格式的对象，输入值中的数组连线会被转换为边。 */
  private parseApiFormat(raw: Record<string, unknown>): Omit<ParsedComfyUiWorkflow, "originalHash"> {
    const nodes: ComfyUiNode[] = [];
    const edges: ComfyUiEdge[] = [];
    for (const [nodeId, nodeValue] of Object.entries(raw)) {
      if (!isRecord(nodeValue) || typeof nodeValue.class_type !== "string") continue;
      const fields = this.fieldsFromApiNode(nodeValue);
      const meta = isRecord(nodeValue._meta) ? nodeValue._meta : undefined;
      nodes.push({
        id: nodeId,
        type: nodeValue.class_type,
        title: meta && typeof meta.title === "string" ? meta.title : undefined,
        fields,
      });
      if (isRecord(nodeValue.inputs)) {
        for (const [fieldName, fieldValue] of Object.entries(nodeValue.inputs)) {
          if (Array.isArray(fieldValue) && fieldValue.length >= 2) {
            edges.push({
              id: `${nodeId}:${fieldName}:${edges.length}`,
              sourceNodeId: String(fieldValue[0]),
              sourceField: `outputs.${String(fieldValue[1])}`,
              targetNodeId: nodeId,
              targetField: `inputs.${fieldName}`,
            });
          }
        }
      }
    }
    return { nodes, edges };
  }

  /** 把 UI 节点记录解析成节点与候选字段。 */
  private nodeFromUiRecord(id: string, node: Record<string, unknown>): ComfyUiNode {
    const inputs = Array.isArray(node.inputs) ? node.inputs as unknown[] : [];
    const outputs = Array.isArray(node.outputs) ? node.outputs as unknown[] : [];
    const widgets = Array.isArray(node.widgets_values) ? node.widgets_values as unknown[] : [];
    const fields: ComfyUiField[] = [
      ...inputs.flatMap((field, index) => {
        if (!isRecord(field)) return [];
        return [{
          name: `inputs.${typeof field.name === "string" ? field.name : `input_${index}`}`,
          kind: "input" as const,
          valueType: inferValueType(field.default),
        }];
      }),
      ...outputs.flatMap((field, index) => {
        if (!isRecord(field)) return [];
        return [{
          name: `outputs.${typeof field.name === "string" ? field.name : `output_${index}`}`,
          kind: "output" as const,
        }];
      }),
      ...widgets.map((value, index) => ({
        name: `widgets_values.${index}`,
        kind: "widget" as const,
        valueType: inferValueType(value),
      })),
    ];
    return {
      id,
      type: typeof node.type === "string" ? node.type : "unknown",
      title: typeof node.title === "string" ? node.title : undefined,
      fields,
    };
  }

  /** 从 API 格式节点中提取输入字段，并按已知节点类型补充输出候选。 */
  private fieldsFromApiNode(node: Record<string, unknown>): ComfyUiField[] {
    const fields: ComfyUiField[] = [];
    if (isRecord(node.inputs)) {
      for (const [name, value] of Object.entries(node.inputs)) {
        fields.push({
          name: `inputs.${name}`,
          kind: "input",
          valueType: inferValueType(value),
        });
      }
    }
    const type = String(node.class_type);
    const outputs = outputFieldNamesForNodeType(type);
    for (const name of outputs) {
      fields.push({ name: `outputs.${name}`, kind: "output" });
    }
    return fields;
  }
}

/** 根据节点类型返回常见输出字段名。 */
function outputFieldNamesForNodeType(type: string): string[] {
  if (/saveimage|previewimage/iu.test(type)) return ["images"];
  if (/saveanimated|animated/iu.test(type)) return ["images", "videos"];
  if (/vhs_videocombine|savevideo/iu.test(type)) return ["videos", "gifs"];
  return ["images", "videos", "gifs", "text", "json"];
}

/** 从 UI 连线槽位解析源节点输出字段名。 */
function sourceFieldFromUiNode(node: Record<string, unknown> | undefined, slot: number): string {
  if (!isRecord(node) || !Array.isArray(node.outputs)) return `outputs.${slot}`;
  const output = node.outputs[slot];
  return isRecord(output) && typeof output.name === "string" ? `outputs.${output.name}` : `outputs.${slot}`;
}

/** 从 UI 连线槽位解析目标节点输入字段名。 */
function targetFieldFromUiNode(node: Record<string, unknown> | undefined, slot: number): string {
  if (!isRecord(node) || !Array.isArray(node.inputs)) return `inputs.${slot}`;
  const input = node.inputs[slot];
  return isRecord(input) && typeof input.name === "string" ? `inputs.${input.name}` : `inputs.${slot}`;
}

/** 推断可用于入参映射的值类型。 */
function inferValueType(value: unknown): AigcWorkflowInputType | undefined {
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "double";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "string";
  return undefined;
}

/** 序列化 JSON 时保持对象键顺序稳定。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
