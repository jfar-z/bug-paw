import type {
  AigcWorkflowDetail,
  ComfyUiEdge,
  ComfyUiNode,
} from "./aigc-contracts";

export interface AigcReferenceInputFamily {
  prefix: string;
  targetFields: string[];
}

export interface AigcReferenceInputBranch {
  rootNodeId: string;
  targetField: string;
  activationNodeIds: string[];
}

/** 按汇总节点输入字段的结构路径归并可选择的接口系列。 */
export function referenceInputFamilies(workflow: Pick<AigcWorkflowDetail, "nodes" | "edges">, boundaryNodeId: string): AigcReferenceInputFamily[] {
  const boundary = workflow.nodes.find((node) => node.id === boundaryNodeId);
  if (!boundary) return [];
  const incoming = workflow.edges.filter((edge) => edge.targetNodeId === boundaryNodeId);
  const fieldOrder = new Map(boundary.fields.map((field, index) => [field.name, index]));
  const groups = new Map<string, string[]>();
  for (const edge of incoming) {
    const prefix = parentFieldPath(edge.targetField);
    const fields = groups.get(prefix) ?? [];
    if (!fields.includes(edge.targetField)) fields.push(edge.targetField);
    groups.set(prefix, fields);
  }
  return [...groups.entries()]
    .map(([prefix, targetFields]) => ({
      prefix,
      targetFields: targetFields.sort((left, right) => fieldIndex(fieldOrder, left) - fieldIndex(fieldOrder, right)),
    }))
    .sort((left, right) => fieldIndex(fieldOrder, left.targetFields[0]) - fieldIndex(fieldOrder, right.targetFields[0]));
}

/** 从用户选定的汇总接口反向追踪互不重叠的单入口分支。 */
export function traceReferenceInputBranches(
  workflow: Pick<AigcWorkflowDetail, "nodes" | "edges">,
  boundaryNodeId: string,
  targetFieldPrefix: string,
): AigcReferenceInputBranch[] {
  const family = referenceInputFamilies(workflow, boundaryNodeId).find((item) => item.prefix === targetFieldPrefix);
  if (!family) return [];
  const boundary = workflow.nodes.find((node) => node.id === boundaryNodeId);
  const fieldOrder = new Map((boundary?.fields ?? []).map((field, index) => [field.name, index]));
  const branches = family.targetFields.map((targetField) => {
    const edge = workflow.edges.find((candidate) => candidate.targetNodeId === boundaryNodeId && candidate.targetField === targetField);
    if (!edge) throw new TypeError(`汇总接口 ${targetField} 缺少上游连线`);
    return traceBranch(workflow.nodes, workflow.edges, boundaryNodeId, edge);
  }).sort((left, right) => fieldIndex(fieldOrder, left.targetField) - fieldIndex(fieldOrder, right.targetField));

  const claimed = new Set<string>();
  for (const branch of branches) {
    for (const nodeId of branch.activationNodeIds) {
      if (claimed.has(nodeId)) throw new TypeError("参考输入分支在汇总节点之前发生交叉");
      claimed.add(nodeId);
    }
  }
  return branches;
}

/** 返回全部分支根节点共有的未连接可写字段。 */
export function commonReferenceInputFields(workflow: AigcWorkflowDetail, branches: AigcReferenceInputBranch[]): string[] {
  if (!branches.length) return [];
  const candidates = branches.map((branch) => rootInputFields(workflow, branch.rootNodeId));
  return candidates[0].filter((field) => candidates.slice(1).every((fields) => fields.includes(field)));
}

function traceBranch(
  nodes: ComfyUiNode[],
  edges: ComfyUiEdge[],
  boundaryNodeId: string,
  boundaryEdge: ComfyUiEdge,
): AigcReferenceInputBranch {
  const activationNodeIds: string[] = [];
  const visited = new Set<string>([boundaryNodeId]);
  let currentNodeId = boundaryEdge.sourceNodeId;
  while (true) {
    if (visited.has(currentNodeId)) throw new TypeError("参考输入分支存在循环连接");
    if (!nodes.some((node) => node.id === currentNodeId)) throw new TypeError(`参考输入分支引用了不存在的节点 ${currentNodeId}`);
    visited.add(currentNodeId);
    activationNodeIds.unshift(currentNodeId);
    const incoming = edges.filter((edge) => edge.targetNodeId === currentNodeId);
    if (incoming.length === 0) break;
    if (incoming.length > 1) throw new TypeError(`节点 #${currentNodeId} 存在多个上游，无法确定唯一用户输入`);
    currentNodeId = incoming[0].sourceNodeId;
  }
  return { rootNodeId: currentNodeId, targetField: boundaryEdge.targetField, activationNodeIds };
}

function rootInputFields(workflow: AigcWorkflowDetail, nodeId: string): string[] {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const connected = new Set(workflow.edges.filter((edge) => edge.targetNodeId === nodeId).map((edge) => edge.targetField));
  const metadataFields = Object.keys(workflow.nodeMetadata?.[node.type]?.fields ?? {})
    .filter((field) => field.startsWith("inputs.") && !connected.has(field));
  if (metadataFields.length) return metadataFields;
  return node.fields
    .filter((field) => (field.kind === "input" || field.kind === "widget") && !connected.has(field.name))
    .map((field) => field.name);
}

function parentFieldPath(field: string): string {
  const segments = field.split(".");
  return segments.length > 2 ? segments.slice(0, -1).join(".") : field;
}

function fieldIndex(order: Map<string, number>, field: string): number {
  return order.get(field) ?? Number.MAX_SAFE_INTEGER;
}
