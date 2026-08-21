import { randomUUID } from "node:crypto";

import type {
  AigcWorkflowCreateInput,
  AigcWorkflowDetail,
  AigcWorkflowDetailDocument,
  AigcWorkflowDocument,
  AigcWorkflowInputGroup,
  AigcWorkflowInputMapping,
  AigcWorkflowInputType,
  AigcWorkflowOutputMapping,
  AigcWorkflowSummary,
  AigcWorkflowUpdateInput,
  ComfyUiEdge,
  ComfyUiFieldMetadata,
  ComfyUiNode,
  ComfyUiNodeMetadata,
} from "../../shared/aigc-contracts";
import { resolveWorkflowFieldMetadata } from "../../shared/aigc-workflow-field-metadata";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";
import { ComfyUiWorkflowParser } from "./comfyui-workflow-parser";

const MAX_WORKFLOW_JSON_BYTES = 4 * 1024 * 1024;
const INPUT_TYPES = new Set<AigcWorkflowInputType>(["bool", "int", "double", "string", "enum", "image", "video", "audio"]);
const OUTPUT_MEDIA_TYPES = new Set(["image", "video", "audio", "json", "text"]);

interface StoredAigcWorkflow extends AigcWorkflowDetail {
  /** 导入时的原始工作流，仅服务端执行使用。 */
  raw: unknown;
}

interface StoredAigcWorkflows {
  workflows: StoredAigcWorkflow[];
}

/** 管理 ComfyUI 工作流导入、解析和字段映射。 */
export class AigcWorkflowService {
  private readonly store;
  private readonly parser = new ComfyUiWorkflowParser();

  /**
   * @param filePath 工作流配置文件路径
   */
  constructor(filePath: string) {
    this.store = createVersionedJsonStore<StoredAigcWorkflows>(filePath);
  }

  /** 列出全部工作流摘要。 */
  async list(): Promise<AigcWorkflowDocument> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    return { revision: loaded.revision, workflows: settings.workflows.map(toSummary) };
  }

  /** 读取单个工作流详情。 */
  async get(id: string): Promise<AigcWorkflowDetailDocument> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const workflow = settings.workflows.find((candidate) => candidate.id === id);
    if (!workflow) throw new Error("AIGC 工作流不存在");
    return { revision: loaded.revision, workflow: toDetail(workflow) };
  }

  /** 导入并保存一个工作流。 */
  async create(input: AigcWorkflowCreateInput): Promise<{ revision: string; workflow: AigcWorkflowDetail }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const workflow = await this.normalizeCreate(input, randomUUID());
    const written = await this.store.write({ workflows: [...settings.workflows, workflow] }, loaded.revision);
    return { revision: written.revision, workflow: toDetail(workflow) };
  }

  /** 更新工作流名称与字段映射，原始工作流内容保持不变。 */
  async update(id: string, input: AigcWorkflowUpdateInput, revision: string): Promise<{ revision: string; workflow: AigcWorkflowDetail }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const index = settings.workflows.findIndex((workflow) => workflow.id === id);
    if (index < 0) throw new Error("AIGC 工作流不存在");
    const previous = settings.workflows[index];
    const inputMappings = normalizeInputMappings(input.inputMappings, previous.nodes, previous.edges, previous.nodeMetadata);
    const next = {
      ...previous,
      name: normalizeName(input.name),
      inputMappings,
      inputGroups: input.inputGroups === undefined
        ? normalizeInputGroups(previous.inputGroups ?? [], inputMappings, previous.nodes)
        : normalizeInputGroups(input.inputGroups, inputMappings, previous.nodes),
      outputMappings: normalizeOutputMappings(input.outputMappings, previous.nodes),
      updatedAt: new Date().toISOString(),
    };
    const workflows = [...settings.workflows];
    workflows[index] = next;
    const written = await this.store.write({ workflows }, revision);
    return { revision: written.revision, workflow: toDetail(next) };
  }

  /** 原子合并当前工作流实际引用的节点元数据。 */
  async syncNodeMetadata(
    id: string,
    metadata: ComfyUiNodeMetadata,
    syncedAt: string,
    revision: string,
  ): Promise<{ revision: string; workflow: AigcWorkflowDetail }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const index = settings.workflows.findIndex((workflow) => workflow.id === id);
    if (index < 0) throw new Error("AIGC 工作流不存在");
    const previous = settings.workflows[index];
    const referencedTypes = new Set(previous.nodes.map((node) => node.type));
    const accepted = Object.fromEntries(Object.entries(metadata).filter(([nodeClass]) => referencedTypes.has(nodeClass)));
    const next: StoredAigcWorkflow = {
      ...previous,
      nodeMetadata: { ...(previous.nodeMetadata ?? {}), ...accepted },
      nodeMetadataSyncedAt: syncedAt,
      updatedAt: new Date().toISOString(),
    };
    const workflows = [...settings.workflows];
    workflows[index] = next;
    const written = await this.store.write({ workflows }, revision);
    return { revision: written.revision, workflow: toDetail(next) };
  }

  /** 删除工作流。 */
  async remove(id: string, revision: string): Promise<void> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    if (!settings.workflows.some((workflow) => workflow.id === id)) throw new Error("AIGC 工作流不存在");
    await this.store.write({ workflows: settings.workflows.filter((workflow) => workflow.id !== id) }, revision);
  }

  /** 检查工作流是否存在。 */
  async exists(id: string): Promise<boolean> {
    return (await this.list()).workflows.some((workflow) => workflow.id === id);
  }

  /** 获取工作流内部详情，供接口执行阶段读取。 */
  async getPrivate(id: string): Promise<StoredAigcWorkflow | undefined> {
    const loaded = await this.store.read();
    return normalizeSettings(loaded.value).workflows.find((workflow) => workflow.id === id);
  }

  /** 校验并解析工作流输入。 */
  private async normalizeCreate(input: AigcWorkflowCreateInput, id: string): Promise<StoredAigcWorkflow> {
    const name = normalizeName(input.name);
    const fileName = normalizeFileName(input.fileName);
    const raw = input.workflowJson;
    const bytes = Buffer.byteLength(JSON.stringify(raw) ?? "", "utf8");
    if (bytes > MAX_WORKFLOW_JSON_BYTES) throw new TypeError("ComfyUI 工作流文件不能超过 4 MiB");
    const parsed = this.parser.parse(raw);
    const now = new Date().toISOString();
    const inputMappings = normalizeInputMappings(input.inputMappings, parsed.nodes, parsed.edges);
    return {
      id,
      name,
      fileName,
      originalHash: parsed.originalHash,
      raw,
      nodes: parsed.nodes,
      edges: parsed.edges,
      inputMappings,
      inputGroups: normalizeInputGroups(input.inputGroups, inputMappings, parsed.nodes),
      outputMappings: normalizeOutputMappings(input.outputMappings, parsed.nodes),
      createdAt: now,
      updatedAt: now,
    };
  }
}

/** 将持久化记录映射成列表摘要。 */
function toSummary(workflow: StoredAigcWorkflow): AigcWorkflowSummary {
  return {
    id: workflow.id,
    name: workflow.name,
    fileName: workflow.fileName,
    originalHash: workflow.originalHash,
    nodeCount: workflow.nodes.length,
    edgeCount: workflow.edges.length,
    inputCount: workflow.inputMappings.length,
    outputCount: workflow.outputMappings.length,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

/** 复制详情对象，避免调用方修改持久化内容。 */
function toDetail(workflow: StoredAigcWorkflow): AigcWorkflowDetail {
  const resolvedFieldMetadata = resolveWorkflowFieldMetadata(workflow);
  return {
    id: workflow.id,
    name: workflow.name,
    fileName: workflow.fileName,
    originalHash: workflow.originalHash,
    nodes: workflow.nodes.map((node) => ({ ...node, fields: [...node.fields] })),
    edges: workflow.edges.map((edge) => ({ ...edge })),
    inputMappings: workflow.inputMappings.map(cloneInputMapping),
    inputGroups: (workflow.inputGroups ?? []).map(cloneInputGroup),
    outputMappings: workflow.outputMappings.map((mapping) => ({ ...mapping })),
    ...(workflow.nodeMetadata ? { nodeMetadata: cloneNodeMetadata(workflow.nodeMetadata) } : {}),
    ...(Object.keys(resolvedFieldMetadata).length ? { resolvedFieldMetadata } : {}),
    ...(workflow.nodeMetadataSyncedAt ? { nodeMetadataSyncedAt: workflow.nodeMetadataSyncedAt } : {}),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

/** 兼容缺失或旧格式的配置文件。 */
function normalizeSettings(value: unknown): StoredAigcWorkflows {
  if (!isRecord(value) || !Array.isArray(value.workflows)) return { workflows: [] };
  return {
    workflows: value.workflows
      .filter(isStoredWorkflow)
      .map((workflow) => ({
        ...workflow,
        raw: workflow.raw,
        nodes: workflow.nodes.map((node) => ({ ...node, fields: [...node.fields] })),
        edges: workflow.edges.map((edge) => ({ ...edge })),
        inputMappings: workflow.inputMappings.map(cloneInputMapping),
        inputGroups: Array.isArray(workflow.inputGroups) ? workflow.inputGroups.map(cloneInputGroup) : [],
        outputMappings: workflow.outputMappings.map((mapping) => ({ ...mapping })),
        ...(isRecord(workflow.nodeMetadata) ? { nodeMetadata: normalizeNodeMetadata(workflow.nodeMetadata) } : {}),
        ...(typeof workflow.nodeMetadataSyncedAt === "string" ? { nodeMetadataSyncedAt: workflow.nodeMetadataSyncedAt } : {}),
      })),
  };
}

function normalizeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 80) throw new TypeError("工作流名称长度无效");
  return name;
}

function normalizeFileName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 160) throw new TypeError("工作流文件名长度无效");
  return name;
}

function normalizeInputMappings(value: unknown, nodes: ComfyUiNode[], edges: ComfyUiEdge[], nodeMetadata?: ComfyUiNodeMetadata): AigcWorkflowInputMapping[] {
  if (!Array.isArray(value)) return [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const resolvedFieldMetadata = resolveWorkflowFieldMetadata({ nodes, edges, nodeMetadata });
  const normalized = value.map((mapping) => {
    if (!isRecord(mapping)) throw new TypeError("工作流入参映射格式无效");
    const mappingNodeId = String(mapping.nodeId);
    if (!nodeIds.has(mappingNodeId)) throw new TypeError("工作流入参引用了不存在的节点");
    if (typeof mapping.name !== "string" || !mapping.name.trim() || mapping.name.length > 80) throw new TypeError("工作流入参名称长度无效");
    if (typeof mapping.field !== "string") throw new TypeError("工作流入参字段路径无效");
    const mappingField = mapping.field;
    const mappingNode = nodes.find((node) => node.id === mappingNodeId);
    const isInputField = mappingField.startsWith("inputs.");
    const isWidgetField = mappingField.startsWith("widgets_values.")
      && mappingNode?.fields.some((field) => field.kind === "widget" && field.name === mappingField);
    if ((!isInputField && !isWidgetField) || mappingField.includes("\0")) throw new TypeError("工作流入参字段路径无效");
    const type = mapping.type as AigcWorkflowInputType;
    if (!INPUT_TYPES.has(type)) throw new TypeError("工作流入参类型无效");
    const enumOptions = type === "enum" ? normalizeEnumOptions(mapping.enumOptions) : undefined;
    const required = mapping.required !== false;
    const activation = normalizeInputActivation(mapping.activation, mappingNodeId, required, nodeIds);
    const defaultValue = mapping.defaultValue !== undefined ? normalizeDefaultValue(type, mapping.defaultValue, enumOptions) : undefined;
    const fieldMetadata = resolvedFieldMetadata[mappingNodeId]?.[mappingField]
      ?? nodeMetadata?.[mappingNode?.type ?? ""]?.fields[mappingField];
    const conflict = metadataConflict(fieldMetadata);
    if (conflict) {
      throw new TypeError(`工作流入参 ${mapping.name.trim()} 无法解析：${conflict}`);
    }
    if (defaultValue !== undefined) validateMetadataValue(mapping.name.trim(), type, defaultValue, fieldMetadata, enumOptions);
    return {
      id: typeof mapping.id === "string" && mapping.id ? mapping.id : randomUUID(),
      name: mapping.name.trim(),
      nodeId: mappingNodeId,
      field: mappingField,
      type,
      required,
      ...(enumOptions ? { enumOptions } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(typeof mapping.description === "string" && mapping.description ? { description: mapping.description.slice(0, 240) } : {}),
      ...(activation ? { activation } : {}),
    };
  });
  assertDisjointActivationGroups(normalized);
  return normalized;
}

/** 校验并规范化条件节点组。 */
function normalizeInputActivation(
  value: unknown,
  mappingNodeId: string,
  required: boolean,
  validNodeIds: Set<string>,
): AigcWorkflowInputMapping["activation"] {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.when !== "provided" || !Array.isArray(value.nodeIds) || value.nodeIds.length === 0) {
    throw new TypeError("工作流条件节点组格式无效");
  }
  if (required) throw new TypeError("工作流条件节点组只能绑定可选入参");
  const nodeIds = [...new Set(value.nodeIds.map(String))];
  if (!nodeIds.includes(mappingNodeId)) throw new TypeError("工作流条件节点组必须包含入参映射节点");
  if (nodeIds.some((nodeId) => !validNodeIds.has(nodeId))) throw new TypeError("工作流条件节点组引用了不存在的节点");
  return { when: "provided", nodeIds };
}

/** 避免一个缺失参数误删另一个参数仍需使用的条件节点。 */
function assertDisjointActivationGroups(mappings: AigcWorkflowInputMapping[]): void {
  const claimedNodeIds = new Set<string>();
  for (const mapping of mappings) {
    for (const nodeId of mapping.activation?.nodeIds ?? []) {
      if (claimedNodeIds.has(nodeId)) throw new TypeError("工作流条件节点组不能包含重复节点");
      claimedNodeIds.add(nodeId);
    }
  }
}

/** 深复制入参映射中的节点组，避免调用方修改持久化内容。 */
function cloneInputMapping(mapping: AigcWorkflowInputMapping): AigcWorkflowInputMapping {
  return {
    ...mapping,
    ...(mapping.enumOptions ? { enumOptions: [...mapping.enumOptions] } : {}),
    ...(mapping.activation ? { activation: { ...mapping.activation, nodeIds: [...mapping.activation.nodeIds] } } : {}),
  };
}

/** 校验参考输入组与底层映射的对应关系和稳定顺序。 */
function normalizeInputGroups(value: unknown, mappings: AigcWorkflowInputMapping[], nodes: ComfyUiNode[]): AigcWorkflowInputGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("工作流参考输入组格式无效");
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  const mappingIndex = new Map(mappings.map((mapping, index) => [mapping.id, index]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const claimedMappingIds = new Set<string>();
  const groupIds = new Set<string>();
  return value.map((group) => {
    if (!isRecord(group)) throw new TypeError("工作流参考输入组格式无效");
    const id = typeof group.id === "string" && group.id ? group.id : randomUUID();
    if (groupIds.has(id)) throw new TypeError("工作流参考输入组标识不能重复");
    groupIds.add(id);
    const label = typeof group.label === "string" ? group.label.trim() : "";
    if (!label || label.length > 80) throw new TypeError("工作流参考输入组名称长度无效");
    if (group.type !== "image" && group.type !== "video" && group.type !== "audio") {
      throw new TypeError("工作流参考输入组类型无效");
    }
    if (typeof group.boundaryNodeId !== "string" || !nodeIds.has(group.boundaryNodeId)) {
      throw new TypeError("工作流参考输入组引用了不存在的汇总节点");
    }
    if (typeof group.targetFieldPrefix !== "string" || !group.targetFieldPrefix.startsWith("inputs.") || group.targetFieldPrefix.includes("\0")) {
      throw new TypeError("工作流参考输入组接口路径无效");
    }
    if (!Array.isArray(group.mappingIds) || group.mappingIds.length === 0) {
      throw new TypeError("工作流参考输入组必须包含入参映射");
    }
    const mappingIds = group.mappingIds.map(String);
    if (new Set(mappingIds).size !== mappingIds.length) throw new TypeError("工作流参考输入组包含重复入参");
    for (const mappingId of mappingIds) {
      const mapping = mappingById.get(mappingId);
      if (!mapping) throw new TypeError("工作流参考输入组引用了不存在的入参");
      if (claimedMappingIds.has(mappingId)) throw new TypeError("工作流入参不能同时属于多个参考输入组");
      if (mapping.type !== group.type || mapping.required || !mapping.activation) {
        throw new TypeError("参考输入组成员必须是同类型的可选条件入参");
      }
      claimedMappingIds.add(mappingId);
    }
    const indices = mappingIds.map((mappingId) => mappingIndex.get(mappingId) ?? -1);
    if (indices.some((index, position) => position > 0 && index !== indices[position - 1] + 1)) {
      throw new TypeError("参考输入组成员必须在入参列表中连续排列");
    }
    return { id, label, type: group.type, mappingIds, boundaryNodeId: group.boundaryNodeId, targetFieldPrefix: group.targetFieldPrefix };
  });
}

/** 深复制参考输入组的成员顺序。 */
function cloneInputGroup(group: AigcWorkflowInputGroup): AigcWorkflowInputGroup {
  return { ...group, mappingIds: [...group.mappingIds] };
}

function normalizeOutputMappings(value: unknown, nodes: ComfyUiNode[]): AigcWorkflowOutputMapping[] {
  if (!Array.isArray(value)) return [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  return value.map((mapping) => {
    if (!isRecord(mapping)) throw new TypeError("工作流输出映射格式无效");
    if (!nodeIds.has(String(mapping.nodeId))) throw new TypeError("工作流输出引用了不存在的节点");
    if (typeof mapping.name !== "string" || !mapping.name.trim() || mapping.name.length > 80) throw new TypeError("工作流输出名称长度无效");
    if (typeof mapping.field !== "string" || !mapping.field.startsWith("outputs.") || mapping.field.includes("\0")) throw new TypeError("工作流输出字段路径无效");
    if (typeof mapping.mediaType !== "string" || !OUTPUT_MEDIA_TYPES.has(mapping.mediaType)) throw new TypeError("工作流输出媒体类型无效");
    return {
      id: typeof mapping.id === "string" && mapping.id ? mapping.id : randomUUID(),
      name: mapping.name.trim(),
      nodeId: String(mapping.nodeId),
      field: mapping.field,
      mediaType: mapping.mediaType as AigcWorkflowOutputMapping["mediaType"],
      ...(typeof mapping.description === "string" && mapping.description ? { description: mapping.description.slice(0, 240) } : {}),
    };
  });
}

function normalizeEnumOptions(value: unknown): Array<string | number | boolean> {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("enum 入参必须提供候选值");
  const options = value.map((option) => typeof option === "string" ? option.trim() : option);
  if (options.some((option) => !isScalar(option) || option === "") || new Set(options.map(scalarKey)).size !== options.length) {
    throw new TypeError("enum 入参候选值无效");
  }
  return options;
}

function normalizeDefaultValue(
  type: AigcWorkflowInputType,
  value: unknown,
  enumOptions?: Array<string | number | boolean>,
): string | number | boolean {
  if (type === "bool" && typeof value === "boolean") return value;
  if (type === "int" && typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (type === "double" && typeof value === "number" && Number.isFinite(value)) return value;
  if (type === "string" && typeof value === "string") return value;
  if (type === "enum" && isScalar(value) && enumOptions?.some((option) => Object.is(option, value))) return value;
  throw new TypeError("工作流入参默认值类型无效");
}

/** 校验默认值和运行值共享的 ComfyUI 值域约束。 */
export function validateMetadataValue(
  name: string,
  type: AigcWorkflowInputType,
  value: unknown,
  metadata?: ComfyUiFieldMetadata,
  enumOptions?: Array<string | number | boolean>,
): void {
  if (type === "int" && (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value))) {
    throw new TypeError(`参数 ${name} 必须是有限整数`);
  }
  if (type === "double" && (typeof value !== "number" || !Number.isFinite(value))) throw new TypeError(`参数 ${name} 必须是有限数值`);
  if (typeof value === "number") {
    if (metadata?.min !== undefined && value < metadata.min) throw new TypeError(`参数 ${name} 不能小于 ${metadata.min}`);
    if (metadata?.max !== undefined && value > metadata.max) throw new TypeError(`参数 ${name} 不能大于 ${metadata.max}`);
  }
  // 节点定义是权威值域，映射候选仅用于定义缺失时的手动兜底。
  const allowed = metadata?.enumOptions ?? enumOptions;
  if (type === "enum" && allowed && !allowed.some((option) => Object.is(option, value))) {
    throw new TypeError(`参数 ${name} 不在允许的枚举候选中`);
  }
}

/** 从兼容旧格式的字段元数据中安全读取动态推导冲突。 */
function metadataConflict(metadata?: ComfyUiFieldMetadata): string | undefined {
  return metadata && "conflict" in metadata && typeof metadata.conflict === "string" ? metadata.conflict : undefined;
}

/** 宽容恢复旧存储中的节点元数据，只保留已知安全字段。 */
function normalizeNodeMetadata(value: Record<string, unknown>): ComfyUiNodeMetadata {
  const result: ComfyUiNodeMetadata = {};
  for (const [nodeClass, nodeValue] of Object.entries(value)) {
    if (!isRecord(nodeValue) || !isRecord(nodeValue.fields)) continue;
    const fields: ComfyUiNodeMetadata[string]["fields"] = {};
    for (const [fieldName, fieldValue] of Object.entries(nodeValue.fields)) {
      if (!isRecord(fieldValue) || typeof fieldValue.comfyType !== "string") continue;
      fields[fieldName] = fieldValue as unknown as ComfyUiFieldMetadata;
    }
    result[nodeClass] = {
      fields,
      ...(typeof nodeValue.displayName === "string" ? { displayName: nodeValue.displayName } : {}),
      ...(typeof nodeValue.description === "string" ? { description: nodeValue.description } : {}),
      ...(typeof nodeValue.category === "string" ? { category: nodeValue.category } : {}),
    };
  }
  return result;
}

/** 深复制元数据，防止调用方修改存储快照。 */
function cloneNodeMetadata(value: ComfyUiNodeMetadata): ComfyUiNodeMetadata {
  return Object.fromEntries(Object.entries(value).map(([nodeClass, node]) => [nodeClass, {
    ...node,
    fields: Object.fromEntries(Object.entries(node.fields).map(([field, metadata]) => [field, {
      ...metadata,
      ...(metadata.enumOptions ? { enumOptions: [...metadata.enumOptions] } : {}),
    }])),
  }]));
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function scalarKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}

function isStoredWorkflow(value: unknown): value is StoredAigcWorkflow {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.fileName === "string"
    && typeof value.originalHash === "string"
    && "raw" in value
    && Array.isArray(value.nodes)
    && Array.isArray(value.edges)
    && Array.isArray(value.inputMappings)
    && Array.isArray(value.outputMappings)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
