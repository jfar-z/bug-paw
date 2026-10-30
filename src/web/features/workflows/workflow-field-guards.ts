import type {
  WorkflowDraft,
  WorkflowField,
  WorkflowNode,
} from "../../../shared/workflow-contracts";

/** 只识别首个内置声明，避免用户误输入保留名称后无法改回。 */
export function workflowSystemFieldIndices(
  fields: WorkflowField[],
  reserved: string[],
) {
  return new Set(
    reserved
      .map((name) => fields.findIndex((field) => field.name === name))
      .filter((index) => index >= 0),
  );
}

/** 名称规则与服务端一致，重复项全部提示；循环保留名不能用于普通参数。 */
export function workflowFieldNameErrors(
  fields: WorkflowField[],
  reserved: string[] = [],
  systemNames: string[] = [],
) {
  const system = workflowSystemFieldIndices(fields, systemNames);
  return fields.map((field, index) => {
    if (!field.name) return "请输入参数名。";
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(field.name))
      return "参数名须以英文字母或下划线开头，仅含字母、数字、下划线，最多 80 个字符。";
    if (["__proto__", "prototype", "constructor"].includes(field.name))
      return "该名称为系统保留名称，请更换。";
    if (reserved.includes(field.name) && !system.has(index))
      return `${field.name} 是循环系统参数，不能重复声明。`;
    if (fields.some((other, i) => i !== index && other.name === field.name))
      return `参数名 ${field.name} 已存在，请使用不同名称。`;
    return "";
  });
}

/** 从整个草稿递归检查，关闭属性面板或离开循环体也不能绕过保存校验。 */
export function workflowDraftFieldError(
  draft: WorkflowDraft,
  systemNames: string[] = [],
): string {
  for (const node of draft.nodes) {
    const error = workflowFieldNameErrors(
      node.outputs,
      systemNames.length && node.kind === "input" ? ["index", "item"] : [],
      node.kind === "input" ? systemNames : [],
    ).find(Boolean);
    if (error) return `${node.name}：${error}`;
    if (node.config.loop) {
      const nested = workflowDraftFieldError(
        node.config.loop.body,
        node.config.loop.mode === "array" ? ["index", "item"] : ["index"],
      );
      if (nested) return `${node.name} / ${nested}`;
    }
  }
  return "";
}

/** 删除或改名声明后清理旧映射，避免不可见的入参和循环变量阻止保存。 */
export function workflowLoopInputBindings(
  node: WorkflowNode,
  body: WorkflowDraft,
) {
  const inputs = new Set(
    body.nodes
      .find((n) => n.kind === "input")
      ?.outputs.map((field) => field.name),
  );
  const outputs = new Set(
    body.nodes
      .find((n) => n.kind === "output")
      ?.outputs.map((field) => field.name),
  );
  const allowed = (name: string) =>
    inputs.has(name) && !["index", "item"].includes(name);
  return {
    inputs: Object.fromEntries(
      Object.entries(node.inputs).filter(([name]) => allowed(name)),
    ),
    state: Object.fromEntries(
      Object.entries(node.config.loop!.state).filter(
        ([name, state]) => allowed(name) && outputs.has(state.output),
      ),
    ),
  };
}
