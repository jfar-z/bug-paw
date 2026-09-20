import type {
  AigcWorkflowInputType,
  ComfyUiFieldMetadata,
  ComfyUiNode,
  ComfyUiNodeMetadata,
  ComfyUiNodeTypeMetadata,
  ComfyUiWidgetInputMetadata,
} from "../../shared/aigc-contracts";

interface NormalizedUiLink {
  sourceNodeId: string;
  sourceSlot: number;
  targetNodeId: string;
  targetSlot: number;
}

/** 返回需要向 ComfyUI object_info 请求的真实节点类型。 */
export function remoteComfyUiNodeClasses(raw: unknown, nodes: ComfyUiNode[]): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return uniqueNodeTypes(nodes);
  const definitions = subgraphDefinitions(raw.definitions);
  const remote = new Set<string>();
  collectRemoteNodeClasses(raw.nodes, definitions, remote, new Set());
  return [...remote];
}

/** 返回当前工作流允许持久化的真实节点与子图节点类型。 */
export function referencedComfyUiNodeMetadataClasses(raw: unknown, nodes: ComfyUiNode[]): Set<string> {
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return new Set(uniqueNodeTypes(nodes));
  const definitions = subgraphDefinitions(raw.definitions);
  const remote = new Set<string>();
  const subgraphs = new Set<string>();
  collectRemoteNodeClasses(raw.nodes, definitions, remote, subgraphs);
  return new Set([...remote, ...subgraphs]);
}

/** 将子图公开端口投影为类级字段元数据，供顶层 PrimitiveNode 反向推导约束。 */
export function projectComfyUiSubgraphMetadata(raw: unknown, metadata: ComfyUiNodeMetadata): ComfyUiNodeMetadata {
  if (!isRecord(raw)) return {};
  const definitions = subgraphDefinitions(raw.definitions);
  const projected: ComfyUiNodeMetadata = {};
  const resolving = new Set<string>();

  const resolveDefinition = (nodeClass: string): ComfyUiNodeTypeMetadata | undefined => {
    if (projected[nodeClass]) return projected[nodeClass];
    const definition = definitions.get(nodeClass);
    if (!definition || resolving.has(nodeClass)) return undefined;
    resolving.add(nodeClass);
    const fields: Record<string, ComfyUiFieldMetadata> = {};
    const inputs = Array.isArray(definition.inputs) ? definition.inputs : [];
    const links = normalizeUiLinks(definition.links);
    const internalNodes = Array.isArray(definition.nodes) ? definition.nodes.filter(isRecord) : [];

    for (let index = 0; index < inputs.length; index += 1) {
      const input = isRecord(inputs[index]) ? inputs[index] : undefined;
      if (!input || typeof input.name !== "string") continue;
      const targets = links.filter((link) => link.sourceNodeId === "-10" && link.sourceSlot === index);
      const targetMetadata = targets.flatMap((link) => {
        const targetNode = internalNodes.find((node) => String(node.id) === link.targetNodeId);
        if (!targetNode || typeof targetNode.type !== "string") return [];
        const targetField = uiInputName(targetNode, link.targetSlot);
        if (!targetField) return [];
        const targetNodeMetadata = definitions.has(targetNode.type)
          ? resolveDefinition(targetNode.type)
          : metadata[targetNode.type];
        const field = targetNodeMetadata?.fields[`inputs.${targetField}`];
        return field ? [field] : [];
      });
      const field = mergeFieldMetadata(targetMetadata) ?? fieldMetadataFromPort(input);
      if (field) fields[`inputs.${input.name}`] = { ...field, required: true };
    }

    const widgetInputs = subgraphWidgetInputs(raw, nodeClass, definitions);
    const result: ComfyUiNodeTypeMetadata = {
      fields,
      ...(widgetInputs ? { widgetInputs } : {}),
      ...(typeof definition.name === "string" && definition.name.trim() ? { displayName: definition.name.trim() } : {}),
    };
    projected[nodeClass] = result;
    resolving.delete(nodeClass);
    return result;
  };

  for (const nodeClass of definitions.keys()) resolveDefinition(nodeClass);
  return projected;
}

/** 递归收集 UI 工作流及其子图中的真实 object_info 节点类型。 */
function collectRemoteNodeClasses(
  nodesValue: unknown,
  definitions: Map<string, Record<string, unknown>>,
  remote: Set<string>,
  subgraphs: Set<string>,
): void {
  if (!Array.isArray(nodesValue)) return;
  for (const node of nodesValue) {
    if (!isRecord(node) || typeof node.type !== "string") continue;
    const definition = definitions.get(node.type);
    if (definition) {
      if (subgraphs.has(node.type)) continue;
      subgraphs.add(node.type);
      collectRemoteNodeClasses(definition.nodes, definitions, remote, subgraphs);
      continue;
    }
    if (node.type === "PrimitiveNode" || isUiOnlyNode(node)) continue;
    remote.add(node.type);
  }
}

function uniqueNodeTypes(nodes: ComfyUiNode[]): string[] {
  return [...new Set(nodes.map((node) => node.type).filter(Boolean))];
}

function subgraphDefinitions(value: unknown): Map<string, Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.subgraphs)) return new Map();
  return new Map(value.subgraphs.flatMap((definition) => isRecord(definition) && typeof definition.id === "string"
    ? [[definition.id, definition] as const]
    : []));
}

/** 前端说明节点没有输入输出，也不会进入 Prompt API。 */
function isUiOnlyNode(node: Record<string, unknown>): boolean {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  return inputs.length === 0 && outputs.length === 0 && /(?:markdown|note)$/iu.test(String(node.type));
}

function normalizeUiLinks(value: unknown): NormalizedUiLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link) => {
    if (Array.isArray(link) && link.length >= 5) {
      return [{ sourceNodeId: String(link[1]), sourceSlot: Number(link[2]), targetNodeId: String(link[3]), targetSlot: Number(link[4]) }];
    }
    if (!isRecord(link)) return [];
    return [{
      sourceNodeId: String(link.origin_id),
      sourceSlot: Number(link.origin_slot),
      targetNodeId: String(link.target_id),
      targetSlot: Number(link.target_slot),
    }];
  }).filter((link) => Number.isInteger(link.sourceSlot) && Number.isInteger(link.targetSlot));
}

function uiInputName(node: Record<string, unknown>, slot: number): string | undefined {
  if (!Array.isArray(node.inputs)) return undefined;
  const input = node.inputs[slot];
  return isRecord(input) && typeof input.name === "string" ? input.name : undefined;
}

/** 从子图实例保存的具名控件顺序恢复 widgets_values 的稳定接口名。 */
function subgraphWidgetInputs(
  raw: Record<string, unknown>,
  nodeClass: string,
  definitions: Map<string, Record<string, unknown>>,
): ComfyUiWidgetInputMetadata[] | undefined {
  const containers = [raw.nodes, ...[...definitions.values()].map((definition) => definition.nodes)];
  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    for (const node of container) {
      if (!isRecord(node) || node.type !== nodeClass || !Array.isArray(node.widgets_values)) continue;
      const named = isRecord(node.widgets_values_named) ? Object.keys(node.widgets_values_named) : [];
      if (named.length === node.widgets_values.length && named.every(safeWidgetName)) {
        return named.map((name) => ({ name }));
      }
      const inputs = Array.isArray(node.inputs) ? node.inputs : [];
      const widgetNames = inputs.flatMap((input) => {
        if (!isRecord(input) || !isRecord(input.widget)) return [];
        const name = typeof input.widget.name === "string" ? input.widget.name : input.name;
        return safeWidgetName(name) ? [name] : [];
      });
      if (widgetNames.length === node.widgets_values.length) return widgetNames.map((name) => ({ name }));
    }
  }
  return undefined;
}

function safeWidgetName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\0\r\n]/u.test(value);
}

/** 端口字面类型只作为内部定义缺失时的保守兜底。 */
function fieldMetadataFromPort(port: Record<string, unknown>): ComfyUiFieldMetadata | undefined {
  if (typeof port.type !== "string" || !port.type) return undefined;
  const comfyType = port.type.toUpperCase();
  const valueType = valueTypeFromComfyType(comfyType);
  return { comfyType, ...(valueType ? { valueType } : {}) };
}

function valueTypeFromComfyType(comfyType: string): AigcWorkflowInputType | undefined {
  if (comfyType === "COMBO") return "enum";
  if (comfyType === "INT") return "int";
  if (comfyType === "FLOAT") return "double";
  if (comfyType === "STRING") return "string";
  if (comfyType === "BOOLEAN") return "bool";
  return undefined;
}

/** 多个内部目标共享同一公开端口时，仅保留能够安全求交的约束。 */
function mergeFieldMetadata(fields: ComfyUiFieldMetadata[]): ComfyUiFieldMetadata | undefined {
  if (fields.length === 0) return undefined;
  if (fields.length === 1) return cloneFieldMetadata(fields[0]);
  const valueTypes = fields.map((field) => field.valueType);
  if (valueTypes.some((value) => !value)) return undefined;
  const uniqueTypes = new Set(valueTypes as AigcWorkflowInputType[]);
  const valueType = uniqueTypes.size === 1
    ? valueTypes[0]
    : [...uniqueTypes].every((type) => type === "int" || type === "double")
      ? "double"
      : [...uniqueTypes].every((type) => type === "string" || type === "enum") && uniqueTypes.has("enum")
        ? "enum"
        : undefined;
  if (!valueType) return undefined;
  const merged: ComfyUiFieldMetadata = { comfyType: valueType === "enum" ? "COMBO" : fields[0].comfyType, valueType };
  if (valueType === "enum") {
    const groups = fields.map((field) => field.enumOptions);
    if (groups.some((options) => !options?.length)) return undefined;
    const [first, ...rest] = groups as NonNullable<ComfyUiFieldMetadata["enumOptions"]>[];
    const enumOptions = first.filter((option) => rest.every((options) => options.some((candidate) => Object.is(candidate, option))));
    if (enumOptions.length === 0) return undefined;
    merged.enumOptions = enumOptions;
  }
  if (valueType === "int" || valueType === "double") {
    const minimums = fields.flatMap((field) => field.min === undefined ? [] : [field.min]);
    const maximums = fields.flatMap((field) => field.max === undefined ? [] : [field.max]);
    if (minimums.length) merged.min = Math.max(...minimums);
    if (maximums.length) merged.max = Math.min(...maximums);
    if (merged.min !== undefined && merged.max !== undefined && merged.min > merged.max) return undefined;
  }
  return merged;
}

function cloneFieldMetadata(field: ComfyUiFieldMetadata): ComfyUiFieldMetadata {
  return { ...field, ...(field.enumOptions ? { enumOptions: [...field.enumOptions] } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
