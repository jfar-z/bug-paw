import type {
  WorkflowDraft,
  WorkflowNode,
  WorkflowBinding,
} from "../../../shared/workflow-contracts";
import { workflowClientId } from "./workflow-id";

/** 检查控制依赖路径，数据引用新增依赖时也复用这一判断。 */
export function workflowHasPath(
  draft: WorkflowDraft,
  source: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (source === target) return true;
  if (seen.has(source)) return false;
  seen.add(source);
  return draft.edges.some(
    (e) =>
      e.source === source && workflowHasPath(draft, e.target, target, seen),
  );
}
/** 收集配置中的引用；绑定与控制边保持一致，已有分支路径不被直连旁路覆盖。 */
export function withWorkflowNode(
  draft: WorkflowDraft,
  node: WorkflowNode,
): WorkflowDraft {
  let next = {
    ...draft,
    nodes: draft.nodes.map((n) => (n.id === node.id ? node : n)),
    edges: [...draft.edges],
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const b = value as WorkflowBinding;
    if (b.kind === "reference") {
      if (workflowHasPath(next, node.id, b.nodeId))
        throw new Error("该引用会形成循环，请选择上游节点。");
      if (!workflowHasPath(next, b.nodeId, node.id)) {
        const source = next.nodes.find((n) => n.id === b.nodeId);
        if (source?.kind === "condition")
          throw new Error(
            "请先从判断节点的 IF 或 ELSE 端口连接目标节点，再引用结果。",
          );
        next.edges.push({
          id: workflowClientId(),
          source: b.nodeId,
          target: node.id,
        });
      }
    } else if (b.kind !== "literal")
      for (const child of Object.values(value)) visit(child);
  };
  visit(node.inputs);
  if (node.kind === "loop" && node.config.loop) {
    if (node.config.loop.mode === "count") visit(node.config.loop.count);
    if (node.config.loop.mode === "array") visit(node.config.loop.items);
    for (const state of Object.values(node.config.loop.state))
      visit(state.initial);
  }
  visit(node.config.referenceGroups);
  visit(node.config.conditions);
  visit(node.config.candidates);
  visit(node.config.selectCondition);
  return next;
}
