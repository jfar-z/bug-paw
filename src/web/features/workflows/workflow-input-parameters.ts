import type {
  WorkflowDraft,
  WorkflowField,
  WorkflowNode,
} from "../../../shared/workflow-contracts";
import { withWorkflowNode } from "./workflow-graph";

/** 输入参数复用只追加字段；冲突和容量错误必须在修改草稿之前整体拒绝。 */
export function appendWorkflowInputFields(
  draft: WorkflowDraft,
  source: WorkflowField[],
  names: string[],
  reserved: string[] = [],
  sameScope = false,
): WorkflowDraft {
  const input = draft.nodes.find((node) => node.kind === "input");
  if (!input) throw new Error("粘贴参数时找不到目标输入节点。");
  if (!names.length) throw new Error("请至少选择一个输入参数。");
  const used = new Set(input.outputs.map((field) => field.name));
  const fields = names.map((name) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) ||
      ["__proto__", "constructor", "prototype"].includes(name)
    )
      throw new Error(`输入参数 ${name} 的名称不合法，请先修改源参数。`);
    if (reserved.includes(name))
      throw new Error(`输入参数 ${name} 是循环内置参数，不能覆盖。`);
    if (used.has(name))
      throw new Error(`输入参数 ${name} 已存在，不能重复导入或覆盖。`);
    const matches = source.filter((field) => field.name === name);
    if (matches.length !== 1)
      throw new Error(`源输入参数 ${name} 已删除或重名，请重新选择。`);
    used.add(name);
    const field = structuredClone(matches[0]);
    // 跨作用域只保留枚举选项，不将外层 AIGC 节点标识带入内部 DAG。
    if (!sameScope) delete field.enumSource;
    return field;
  });
  if (used.size > 100)
    throw new Error("导入后输入参数超过 100 项，请减少选择数量。");
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === input.id
        ? { ...node, outputs: [...node.outputs, ...fields] }
        : node,
    ),
  };
}

/** 沿当前循环路径导入直接外层的输入，并在同一次草稿更新中建立入参与控制依赖。 */
export function importOuterWorkflowInputs(
  draft: WorkflowDraft,
  path: string[],
  names: string[],
): WorkflowDraft {
  const loop = draft.nodes.find((node) => node.id === path[0]);
  if (!path.length || !loop?.config.loop)
    throw new Error("导入外层输入时循环路径已变更，请重新进入循环体。");
  let next: WorkflowNode;
  if (path.length > 1) {
    const body = importOuterWorkflowInputs(
      loop.config.loop.body,
      path.slice(1),
      names,
    );
    next = {
      ...loop,
      config: { ...loop.config, loop: { ...loop.config.loop, body } },
    };
  } else {
    const input = draft.nodes.find((node) => node.kind === "input");
    if (!input) throw new Error("导入参数时找不到外层输入节点。");
    for (const name of names)
      if (
        Object.hasOwn(loop.inputs, name) ||
        Object.hasOwn(loop.config.loop.state, name)
      )
        throw new Error(
          `循环入参 ${name} 已有绑定或变量设置，不能覆盖，请先检查循环配置。`,
        );
    const body = appendWorkflowInputFields(
      loop.config.loop.body,
      input.outputs,
      names,
      ["index", "item"],
    );
    const inputs = { ...loop.inputs };
    for (const name of names)
      inputs[name] = { kind: "reference", nodeId: input.id, field: name };
    next = {
      ...loop,
      inputs,
      config: { ...loop.config, loop: { ...loop.config.loop, body } },
    };
  }
  const result = withWorkflowNode(draft, next);
  if (result.edges.length > 400)
    throw new Error("导入参数后控制连线超过 400 条，未修改工作流。");
  return result;
}
