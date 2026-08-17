import { randomUUID } from "node:crypto";

import type {
  AigcWorkflowCreateInput,
  AigcWorkflowDetail,
  AigcWorkflowDetailDocument,
  AigcWorkflowDocument,
  AigcWorkflowInputMapping,
  AigcWorkflowInputType,
  AigcWorkflowOutputMapping,
  AigcWorkflowSummary,
  AigcWorkflowUpdateInput,
  ComfyUiEdge,
  ComfyUiNode,
} from "../../shared/aigc-contracts";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";
import { ComfyUiWorkflowParser } from "./comfyui-workflow-parser";

const MAX_WORKFLOW_JSON_BYTES = 4 * 1024 * 1024;
const INPUT_TYPES = new Set<AigcWorkflowInputType>(["bool", "int", "double", "string", "enum", "image", "video"]);
const OUTPUT_MEDIA_TYPES = new Set(["image", "video", "json", "text"]);

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
    const next = {
      ...previous,
      name: normalizeName(input.name),
      inputMappings: normalizeInputMappings(input.inputMappings, previous.nodes),
      outputMappings: normalizeOutputMappings(input.outputMappings, previous.nodes),
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
    return {
      id,
      name,
      fileName,
      originalHash: parsed.originalHash,
      raw,
      nodes: parsed.nodes,
      edges: parsed.edges,
      inputMappings: normalizeInputMappings(input.inputMappings, parsed.nodes),
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
  return {
    id: workflow.id,
    name: workflow.name,
    fileName: workflow.fileName,
    originalHash: workflow.originalHash,
    nodes: workflow.nodes.map((node) => ({ ...node, fields: [...node.fields] })),
    edges: workflow.edges.map((edge) => ({ ...edge })),
    inputMappings: workflow.inputMappings.map((mapping) => ({ ...mapping })),
    outputMappings: workflow.outputMappings.map((mapping) => ({ ...mapping })),
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
        inputMappings: workflow.inputMappings.map((mapping) => ({ ...mapping })),
        outputMappings: workflow.outputMappings.map((mapping) => ({ ...mapping })),
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

function normalizeInputMappings(value: unknown, nodes: ComfyUiNode[]): AigcWorkflowInputMapping[] {
  if (!Array.isArray(value)) return [];
  const nodeIds = new Set(nodes.map((node) => node.id));
  return value.map((mapping) => {
    if (!isRecord(mapping)) throw new TypeError("工作流入参映射格式无效");
    if (!nodeIds.has(String(mapping.nodeId))) throw new TypeError("工作流入参引用了不存在的节点");
    if (typeof mapping.name !== "string" || !mapping.name.trim() || mapping.name.length > 80) throw new TypeError("工作流入参名称长度无效");
    if (typeof mapping.field !== "string" || !mapping.field.startsWith("inputs.") || mapping.field.includes("\0")) throw new TypeError("工作流入参字段路径无效");
    const type = mapping.type as AigcWorkflowInputType;
    if (!INPUT_TYPES.has(type)) throw new TypeError("工作流入参类型无效");
    const enumOptions = type === "enum" ? normalizeEnumOptions(mapping.enumOptions) : undefined;
    return {
      id: typeof mapping.id === "string" && mapping.id ? mapping.id : randomUUID(),
      name: mapping.name.trim(),
      nodeId: String(mapping.nodeId),
      field: mapping.field,
      type,
      required: mapping.required !== false,
      ...(enumOptions ? { enumOptions } : {}),
      ...(mapping.defaultValue !== undefined ? { defaultValue: normalizeDefaultValue(type, mapping.defaultValue) } : {}),
      ...(typeof mapping.description === "string" && mapping.description ? { description: mapping.description.slice(0, 240) } : {}),
    };
  });
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

function normalizeEnumOptions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("enum 入参必须提供候选值");
  const options = value.map((option) => String(option).trim()).filter(Boolean);
  if (options.length !== value.length || new Set(options).size !== options.length) throw new TypeError("enum 入参候选值无效");
  return options;
}

function normalizeDefaultValue(type: AigcWorkflowInputType, value: unknown): string | number | boolean {
  if (type === "bool" && typeof value === "boolean") return value;
  if ((type === "int" || type === "double") && typeof value === "number" && Number.isFinite(value)) return value;
  if (type === "string" && typeof value === "string") return value;
  throw new TypeError("工作流入参默认值类型无效");
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
