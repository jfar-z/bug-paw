import {
  workflowNodesDeep,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowNode,
} from "../../shared/workflow-contracts";
import {
  checkField,
  invalid,
  validateWorkflow,
  workflowFieldsCompatible,
} from "./workflow-validation";

/** 只提取显式调用，包括所有循环体；不依据可达分支跳过依赖检查。 */
export function workflowDependencies(graph: WorkflowDraft): string[] {
  return [
    ...new Set(
      workflowNodesDeep(graph)
        .filter((node) => node.kind === "workflow" && node.config.workflowId)
        .map((node) => node.config.workflowId!),
    ),
  ];
}

/** 在同步读取临界区构建依赖闭包，返回执行期间不可变的定义快照。 */
export function snapshotWorkflowDependencies(
  root: WorkflowDefinition,
  read: (id: string) => WorkflowDefinition | undefined,
  runnable = false,
): Record<string, WorkflowDefinition> {
  const result: Record<string, WorkflowDefinition> = {};
  const stack: WorkflowDefinition[] = [];
  let count = 0;
  const visit = (definition: WorkflowDefinition) => {
    const cycle = stack.findIndex((item) => item.id === definition.id);
    if (cycle >= 0)
      invalid(
        `工作流循环依赖：${[...stack.slice(cycle), definition].map((item) => `${item.name} (${item.id})`).join(" → ")}`,
      );
    if (Object.hasOwn(result, definition.id)) return;
    if (stack.length >= 16 || ++count > 100)
      invalid("工作流依赖超过 16 层或 100 个定义");
    validateWorkflow(definition, runnable);
    stack.push(definition);
    for (const id of workflowDependencies(definition)) {
      const target = id === root.id ? root : read(id);
      if (!target) invalid(`工作流 ${definition.name} 调用的目标 ${id} 不存在`);
      visit(target);
    }
    // 每个作用域单独检查绑定，防止同名内部节点污染外层参数类型判断。
    const checkGraph = (graph: WorkflowDraft) => {
      for (const node of graph.nodes) {
        if (node.kind === "workflow" && node.config.workflowId)
          checkWorkflowInvocation(
            node,
            result[node.config.workflowId],
            graph.nodes,
            runnable,
          );
        if (node.kind === "loop" && node.config.loop)
          checkGraph(node.config.loop.body);
      }
    };
    checkGraph(definition);
    stack.pop();
    result[definition.id] = structuredClone(definition);
  };
  visit(root);
  // 组合循环与调用层级一起计算，避免在执行计费节点后才发现静态嵌套超限。
  const heights = new Map<string, number>();
  const height = (graph: WorkflowDraft): number =>
    Math.max(
      0,
      ...graph.nodes.map((node) => {
        if (node.kind === "loop" && node.config.loop)
          return 1 + height(node.config.loop.body);
        if (node.kind !== "workflow" || !node.config.workflowId) return 0;
        const id = node.config.workflowId;
        if (!heights.has(id)) heights.set(id, height(result[id]));
        return 1 + heights.get(id)!;
      }),
    );
  if (height(root) > 16) invalid("循环与工作流调用的组合嵌套超过 16 层");
  delete result[root.id];
  return result;
}

/** 调用节点锁定参数类型契约；目标变更后必须由编辑者显式同步。 */
function checkWorkflowInvocation(
  node: WorkflowNode,
  definition: WorkflowDefinition,
  siblings: WorkflowNode[],
  runnable: boolean,
): void {
  const fields = definition.nodes.find(
    (item) => item.kind === "input",
  )!.outputs;
  const outputs = definition.nodes.find(
    (item) => item.kind === "output",
  )!.outputs;
  if (
    node.outputs.length !== outputs.length ||
    outputs.some(
      (field) =>
        !node.outputs.some(
          (output) =>
            output.name === field.name &&
            workflowFieldsCompatible(output, field) &&
            workflowFieldsCompatible(field, output) &&
            !!output.required === !!field.required &&
            JSON.stringify(output.enumValues ?? []) ===
              JSON.stringify(field.enumValues ?? []) &&
            JSON.stringify(output.defaultValue) ===
              JSON.stringify(field.defaultValue),
        ),
    )
  )
    invalid(`节点 ${node.name} 的目标工作流出参已变化，请重新选择或同步参数`);
  for (const name of Object.keys(node.inputs))
    if (!fields.some((field) => field.name === name))
      invalid(`节点 ${node.name} 的目标工作流已移除入参 ${name}`);
  for (const field of fields) {
    const binding = node.inputs[field.name];
    if (!binding) {
      if (runnable && field.required && field.defaultValue === undefined)
        invalid(`节点 ${node.name} 尚未绑定工作流入参 ${field.name}`);
    } else if (binding.kind === "literal") checkField(field, binding.value);
    else {
      const source = siblings
        .find((item) => item.id === binding.nodeId)
        ?.outputs.find((output) => output.name === binding.field);
      if (!source || !workflowFieldsCompatible(source, field))
        invalid(`节点 ${node.name} 的入参 ${field.name} 与上游类型不兼容`);
    }
  }
}
