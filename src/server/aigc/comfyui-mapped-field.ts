import type { ComfyUiNodeMetadata, ComfyUiWidgetInputMetadata } from "../../shared/aigc-contracts";

/** 将 UI 工作流的控件索引解析为 ComfyUI API Prompt 的稳定输入字段。 */
export function resolveComfyUiMappedField(
  raw: unknown,
  nodeMetadata: ComfyUiNodeMetadata | undefined,
  nodeId: string,
  field: string,
): string {
  if (!isRecord(raw) || !Array.isArray(raw.nodes) || !field.startsWith("widgets_values.")) return field;
  const index = Number(field.slice("widgets_values.".length));
  if (!Number.isInteger(index) || index < 0) return field;
  const node = raw.nodes.find((value) => isRecord(value) && String(value.id) === nodeId);
  if (!isRecord(node) || !Array.isArray(node.widgets_values) || typeof node.type !== "string") return field;
  // PrimitiveNode 不会进入 API Prompt，必须保留控件索引供执行阶段改写下游节点。
  if (node.type === "PrimitiveNode") return field;
  const descriptors = nodeMetadata?.[node.type]?.widgetInputs;
  const resolved = descriptors?.length
    ? expandWidgetInputNames(descriptors, node.widgets_values)[index]
    : fallbackWidgetInputName(node, index);
  return resolved ? `inputs.${resolved}` : field;
}

/** 判断字段是否表示 PrimitiveNode 的首个实际值，兼容已持久化的 API 字段别名。 */
export function isComfyUiPrimitiveValueField(
  raw: unknown,
  nodeMetadata: ComfyUiNodeMetadata | undefined,
  nodeId: string,
  field: string,
): boolean {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return false;
  const node = raw.nodes.find((value) => isRecord(value) && String(value.id) === nodeId);
  if (!isRecord(node) || node.type !== "PrimitiveNode" || !Array.isArray(node.widgets_values)) return false;
  if (field === "widgets_values.0") return true;
  const descriptors = nodeMetadata?.PrimitiveNode?.widgetInputs;
  const resolved = descriptors?.length
    ? expandWidgetInputNames(descriptors, node.widgets_values)[0]
    : fallbackWidgetInputName(node, 0);
  return Boolean(resolved) && field === `inputs.${resolved}`;
}

/** 无节点定义时使用 ComfyUI 持久化的具名控件恢复字段名。 */
function fallbackWidgetInputName(node: Record<string, unknown>, index: number): string | undefined {
  const namedValues = isRecord(node.widgets_values_named) ? Object.keys(node.widgets_values_named) : [];
  const named = namedValues[index];
  if (named && named !== "control_after_generate") return named;
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const widgets = inputs.flatMap((value) => {
    if (!isRecord(value) || !isRecord(value.widget)) return [];
    const name = typeof value.widget.name === "string" ? value.widget.name : value.name;
    return typeof name === "string" ? [name] : [];
  });
  return widgets[index];
}

/** 动态控件根据当前选项在父字段后展开对应子字段。 */
function expandWidgetInputNames(descriptors: ComfyUiWidgetInputMetadata[], values: unknown[]): string[] {
  const names: string[] = [];
  for (const descriptor of descriptors) {
    const selectedValue = values[names.length];
    names.push(descriptor.name);
    if (descriptor.dynamicOptions && isWidgetScalar(selectedValue)) {
      const nested = descriptor.dynamicOptions[String(selectedValue)] ?? [];
      names.push(...nested.map((name) => `${descriptor.name}.${name}`));
    }
  }
  return names;
}

function isWidgetScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
