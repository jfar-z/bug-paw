import type {
  AigcWorkflowInputType,
  ComfyUiEdge,
  ComfyUiFieldMetadata,
  ComfyUiNode,
  ComfyUiNodeMetadata,
  ComfyUiResolvedFieldMetadata,
  ComfyUiResolvedFieldMetadataMap,
} from "./aigc-contracts";

interface WorkflowMetadataSource {
  nodes: ComfyUiNode[];
  edges: ComfyUiEdge[];
  nodeMetadata?: ComfyUiNodeMetadata;
}

const DYNAMIC_NODE_HANDLERS = new Map<string, (source: WorkflowMetadataSource, node: ComfyUiNode, resolved: ComfyUiResolvedFieldMetadataMap) => void>([
  ["PrimitiveNode", resolvePrimitiveNode],
]);

/** 合并类级定义、工作流静态类型和已登记动态节点的连接约束。 */
export function resolveWorkflowFieldMetadata(source: WorkflowMetadataSource): ComfyUiResolvedFieldMetadataMap {
  const resolved: ComfyUiResolvedFieldMetadataMap = {};
  for (const node of source.nodes) {
    for (const field of node.fields) {
      const direct = source.nodeMetadata?.[node.type]?.fields[field.name];
      if (direct) {
        setResolvedField(resolved, node.id, field.name, { ...cloneMetadata(direct), source: "direct" });
      } else if (field.valueType) {
        setResolvedField(resolved, node.id, field.name, {
          comfyType: comfyTypeFromValueType(field.valueType),
          valueType: field.valueType,
          source: "workflow",
        });
      }
    }
  }
  for (const node of source.nodes) DYNAMIC_NODE_HANDLERS.get(node.type)?.(source, node, resolved);
  return resolved;
}

/** Primitive 的第一个 widget 是实际值，其约束由全部输出目标共同决定。 */
function resolvePrimitiveNode(source: WorkflowMetadataSource, node: ComfyUiNode, resolved: ComfyUiResolvedFieldMetadataMap): void {
  const targetEdges = source.edges.filter((edge) => edge.sourceNodeId === node.id);
  if (targetEdges.length === 0) return;
  const references = targetEdges.map((edge) => ({ nodeId: edge.targetNodeId, field: edge.targetField }));
  const targetMetadata = targetEdges.map((edge) => directTargetMetadata(source, edge));
  // 任一目标定义缺失时保持工作流字面类型，避免把未安装的自定义节点误判为兼容约束。
  if (targetMetadata.some((metadata) => !metadata)) return;
  const inferred = mergeTargetMetadata(targetMetadata as ComfyUiFieldMetadata[]);
  const fallback = resolved[node.id]?.["widgets_values.0"];
  setResolvedField(resolved, node.id, "widgets_values.0", {
    ...(fallback ?? { comfyType: "*" }),
    ...(inferred.metadata ?? {}),
    source: "inferred",
    inferredFrom: references,
    ...(inferred.conflict ? { conflict: inferred.conflict } : {}),
  });
}

function directTargetMetadata(source: WorkflowMetadataSource, edge: ComfyUiEdge): ComfyUiFieldMetadata | undefined {
  const target = source.nodes.find((node) => node.id === edge.targetNodeId);
  return target ? source.nodeMetadata?.[target.type]?.fields[edge.targetField] : undefined;
}

function mergeTargetMetadata(metadata: ComfyUiFieldMetadata[]): { metadata?: ComfyUiFieldMetadata; conflict?: string } {
  const valueTypes = metadata.map((item) => item.valueType).filter((value): value is AigcWorkflowInputType => Boolean(value));
  if (valueTypes.length !== metadata.length) return { conflict: "下游节点定义缺少可用的字段类型" };
  const valueType = mergeValueTypes(valueTypes);
  if (!valueType) return { conflict: `下游字段类型不兼容：${[...new Set(valueTypes)].join("、")}` };

  const merged: ComfyUiFieldMetadata = {
    comfyType: valueType === "enum" ? "COMBO" : metadata[0].comfyType,
    valueType,
  };
  if (valueType === "enum") {
    const enumGroups = metadata.filter((item) => item.valueType === "enum").map((item) => item.enumOptions);
    if (enumGroups.some((options) => !options?.length)) return { conflict: "下游枚举字段缺少候选值" };
    const [first, ...rest] = enumGroups as NonNullable<ComfyUiFieldMetadata["enumOptions"]>[];
    const enumOptions = first.filter((option) => rest.every((options) => options.some((candidate) => Object.is(candidate, option))));
    if (enumOptions.length === 0) return { conflict: "下游枚举字段没有共同候选值" };
    merged.enumOptions = [...enumOptions];
  }
  if (valueType === "int" || valueType === "double") {
    const minimums = metadata.map((item) => item.min).filter((value): value is number => value !== undefined);
    const maximums = metadata.map((item) => item.max).filter((value): value is number => value !== undefined);
    if (minimums.length) merged.min = Math.max(...minimums);
    if (maximums.length) merged.max = Math.min(...maximums);
    if (merged.min !== undefined && merged.max !== undefined && merged.min > merged.max) return { conflict: "下游数值字段的范围没有交集" };
    const steps = metadata.map((item) => item.step);
    if (steps[0] !== undefined && steps.every((step) => step === steps[0])) merged.step = steps[0];
  }
  return { metadata: merged };
}

function mergeValueTypes(types: AigcWorkflowInputType[]): AigcWorkflowInputType | undefined {
  const unique = new Set(types);
  if (unique.size === 1) return types[0];
  if ([...unique].every((type) => type === "int" || type === "double")) return "double";
  if ([...unique].every((type) => type === "string" || type === "enum") && unique.has("enum")) return "enum";
  return undefined;
}

function setResolvedField(
  resolved: ComfyUiResolvedFieldMetadataMap,
  nodeId: string,
  field: string,
  metadata: ComfyUiResolvedFieldMetadata,
): void {
  resolved[nodeId] ??= {};
  resolved[nodeId][field] = metadata;
}

function cloneMetadata(metadata: ComfyUiFieldMetadata): ComfyUiFieldMetadata {
  return { ...metadata, ...(metadata.enumOptions ? { enumOptions: [...metadata.enumOptions] } : {}) };
}

function comfyTypeFromValueType(valueType: AigcWorkflowInputType): string {
  if (valueType === "enum") return "COMBO";
  if (valueType === "double") return "FLOAT";
  return valueType.toUpperCase();
}
