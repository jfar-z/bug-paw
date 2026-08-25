import { randomUUID } from "node:crypto";

import type {
  AigcComfyUiInterfaceConfig,
  AigcGrokInterfaceConfig,
  AigcInterfaceCapability,
  AigcInterfaceDocument,
  AigcInterfaceInput,
  AigcInterfaceProtocol,
  AigcInterfaceRecord,
  AigcOpenAiInterfaceConfig,
  AigcOpenAiParameterDefinition,
  AigcOpenAiParameterType,
  AigcOpenAiParameterValue,
} from "../../shared/aigc-contracts";
import {
  AIGC_OPENAI_RESERVED_PARAMETER_NAMES,
  resolveOpenAiParameterDefinitions,
} from "../../shared/aigc-openai-parameters";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";

interface StoredAigcInterfaces {
  interfaces: AigcInterfaceRecord[];
}

const OPENAI_CAPABILITIES = new Set<AigcInterfaceCapability>(["text-to-image", "image-edit"]);
const GROK_CAPABILITIES = new Set<AigcInterfaceCapability>([
  "text-to-image",
  "image-edit",
  "text-to-video",
  "image-to-video",
  "video-edit",
  "video-extend",
]);

/** 管理 AIGC 接口定义与协议组合。 */
export class AigcInterfaceService {
  private readonly store;

  /**
   * @param filePath 接口配置文件路径
   * @param workflowExists 校验 ComfyUI 工作流是否存在的回调
   */
  constructor(
    filePath: string,
    private readonly workflowExists: (id: string) => Promise<boolean>,
  ) {
    this.store = createVersionedJsonStore<StoredAigcInterfaces>(filePath);
  }

  /** 列出全部接口。 */
  async list(): Promise<AigcInterfaceDocument> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    return { revision: loaded.revision, interfaces: settings.interfaces.map(copyInterface) };
  }

  /** 读取单个接口详情。 */
  async get(id: string): Promise<AigcInterfaceRecord | undefined> {
    return (await this.list()).interfaces.find((item) => item.id === id);
  }

  /** 创建接口定义。 */
  async create(input: AigcInterfaceInput): Promise<{ revision: string; item: AigcInterfaceRecord }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const now = new Date().toISOString();
    const item = await this.normalizeInput(input, randomUUID(), now);
    const written = await this.store.write({ interfaces: [...settings.interfaces, item] }, loaded.revision);
    return { revision: written.revision, item: copyInterface(item) };
  }

  /** 更新接口定义。 */
  async update(id: string, input: AigcInterfaceInput, revision: string): Promise<{ revision: string; item: AigcInterfaceRecord }> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    const index = settings.interfaces.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("AIGC 接口不存在");
    const previous = settings.interfaces[index];
    const item = await this.normalizeInput(input, id, previous.createdAt, new Date().toISOString());
    const interfaces = [...settings.interfaces];
    interfaces[index] = item;
    const written = await this.store.write({ interfaces }, revision);
    return { revision: written.revision, item: copyInterface(item) };
  }

  /** 删除接口定义。 */
  async remove(id: string, revision: string): Promise<void> {
    const loaded = await this.store.read();
    const settings = normalizeSettings(loaded.value);
    if (!settings.interfaces.some((item) => item.id === id)) throw new Error("AIGC 接口不存在");
    await this.store.write({ interfaces: settings.interfaces.filter((item) => item.id !== id) }, revision);
  }

  /** 判断渠道是否仍被任何接口引用。 */
  async isChannelInUse(channelId: string): Promise<boolean> {
    return (await this.list()).interfaces.some((item) => item.channelId === channelId);
  }

  /** 判断工作流是否仍被任何接口引用。 */
  async isWorkflowInUse(workflowId: string): Promise<boolean> {
    return (await this.list()).interfaces.some((item) => item.protocol === "comfyui"
      && (item.config as { workflowId?: string }).workflowId === workflowId);
  }

  /** 校验输入并返回规范接口记录。 */
  private async normalizeInput(
    input: AigcInterfaceInput,
    id: string,
    createdAt: string,
    previousUpdatedAt?: string,
  ): Promise<AigcInterfaceRecord> {
    const name = normalizeText(input.name, "接口名称", 80);
    const description = typeof input.description === "string" ? input.description.trim().slice(0, 240) : "";
    const protocol = input.protocol;
    const capability = input.capability;
    if (!["openai", "grok", "comfyui"].includes(protocol)) throw new TypeError("AIGC 接口协议无效");
    if (typeof input.enabled !== "boolean" || typeof input.toolPublishEnabled !== "boolean") {
      throw new TypeError("AIGC 接口启用状态无效");
    }
    assertProtocolCapability(protocol, capability);
    const config = await normalizeInterfaceConfig(protocol, input.config, this.workflowExists);
    return {
      id,
      name,
      description,
      protocol,
      capability,
      channelId: normalizeText(input.channelId, "渠道标识", 120),
      enabled: input.enabled,
      toolPublishEnabled: input.toolPublishEnabled,
      config,
      createdAt,
      updatedAt: previousUpdatedAt ?? createdAt,
    };
  }
}

/** 判断协议与能力组合是否允许。 */
function assertProtocolCapability(protocol: AigcInterfaceProtocol, capability: AigcInterfaceCapability): void {
  if (protocol === "openai" && !OPENAI_CAPABILITIES.has(capability)) throw new TypeError("OpenAI 渠道当前仅支持文生图和图片编辑");
  if (protocol === "grok" && !GROK_CAPABILITIES.has(capability)) throw new TypeError("Grok 渠道能力无效");
}

/** 按协议校验具体配置。 */
async function normalizeInterfaceConfig(
  protocol: AigcInterfaceProtocol,
  config: unknown,
  workflowExists: (id: string) => Promise<boolean>,
): Promise<AigcOpenAiInterfaceConfig | AigcGrokInterfaceConfig | AigcComfyUiInterfaceConfig> {
  if (!isRecord(config)) throw new TypeError("AIGC 接口配置格式无效");
  if (protocol === "openai") {
    return {
      model: normalizeText(config.model, "OpenAI 模型", 160),
      parameters: normalizeOpenAiParameters(config),
    };
  }
  if (protocol === "grok") {
    return normalizeGrokConfig(config);
  }
  const workflowId = normalizeText(config.workflowId, "工作流标识", 120);
  if (!await workflowExists(workflowId)) throw new TypeError("所选 ComfyUI 工作流不存在");
  return { workflowId };
}

/** 校验 OpenAI 自定义参数，并兼容旧版固定字段。 */
function normalizeOpenAiParameters(config: Record<string, unknown>): AigcOpenAiParameterDefinition[] {
  const legacyConfig = config as unknown as AigcOpenAiInterfaceConfig;
  const source = Array.isArray(config.parameters) ? config.parameters : resolveOpenAiParameterDefinitions(legacyConfig);
  if (source.length > 24) throw new TypeError("OpenAI 自定义参数最多支持 24 项");
  const names = new Set<string>();
  return source.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`OpenAI 参数 ${index + 1} 格式无效`);
    const name = normalizeOpenAiParameterName(value.name, index);
    if (AIGC_OPENAI_RESERVED_PARAMETER_NAMES.has(name)) throw new TypeError(`OpenAI 参数 ${name} 为系统保留字段`);
    if (names.has(name)) throw new TypeError(`OpenAI 参数 ${name} 重复`);
    names.add(name);
    const type = normalizeOpenAiParameterType(value.type, name);
    const enumValues = normalizeOpenAiEnumValues(value.enumValues, type, name);
    const defaultValue = value.defaultValue === undefined
      ? undefined
      : normalizeOpenAiParameterValue(value.defaultValue, type, `OpenAI 参数 ${name} 默认值`);
    if (defaultValue !== undefined && enumValues?.length && !enumValues.some((candidate) => Object.is(candidate, defaultValue))) {
      throw new TypeError(`OpenAI 参数 ${name} 默认值不在枚举范围内`);
    }
    return {
      name,
      type,
      ...(enumValues?.length ? { enumValues } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      description: typeof value.description === "string" ? value.description.trim().slice(0, 240) : "",
    };
  });
}

/** 校验第三方请求参数名，允许常见点号、连字符和下划线命名。 */
function normalizeOpenAiParameterName(value: unknown, index: number): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/u.test(value.trim())) {
    throw new TypeError(`OpenAI 参数 ${index + 1} 名称无效`);
  }
  return value.trim();
}

/** 校验自定义参数类型。 */
function normalizeOpenAiParameterType(value: unknown, name: string): AigcOpenAiParameterType {
  if (value === "string" || value === "integer" || value === "number" || value === "boolean") return value;
  throw new TypeError(`OpenAI 参数 ${name} 类型无效`);
}

/** 校验枚举列表，并按类型去重。 */
function normalizeOpenAiEnumValues(value: unknown, type: AigcOpenAiParameterType, name: string): AigcOpenAiParameterValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 50) throw new TypeError(`OpenAI 参数 ${name} 枚举无效`);
  const result: AigcOpenAiParameterValue[] = [];
  for (const candidate of value) {
    const normalized = normalizeOpenAiParameterValue(candidate, type, `OpenAI 参数 ${name} 枚举值`);
    if (!result.some((existing) => Object.is(existing, normalized))) result.push(normalized);
  }
  return result;
}

/** 按声明类型校验一个标量参数值。 */
function normalizeOpenAiParameterValue(value: unknown, type: AigcOpenAiParameterType, label: string): AigcOpenAiParameterValue {
  if (type === "string" && typeof value === "string") return value;
  if (type === "boolean" && typeof value === "boolean") return value;
  if ((type === "number" || type === "integer") && typeof value === "number" && Number.isFinite(value)) {
    if (type === "integer" && !Number.isInteger(value)) throw new TypeError(`${label}必须为整数`);
    return value;
  }
  throw new TypeError(`${label}类型不匹配`);
}

/** 校验并归一化 Grok 接口配置。 */
function normalizeGrokConfig(config: Record<string, unknown>): AigcGrokInterfaceConfig {
  const result: AigcGrokInterfaceConfig = {
    model: normalizeText(config.model, "Grok 模型", 160),
  };
  const size = normalizeOptionalSize(config.size);
  if (size) result.size = size;
  const duration = normalizeOptionalInteger(config.duration, "视频时长", 1, 300);
  if (duration !== undefined) result.duration = duration;
  return result;
}

/** 校验可选尺寸，必须使用 WIDTHxHEIGHT 格式。 */
function normalizeOptionalSize(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^\d{2,5}x\d{2,5}$/u.test(value.trim())) {
    throw new TypeError("Grok 尺寸必须使用 WIDTHxHEIGHT 格式");
  }
  return value.trim();
}

/** 校验可选整数，空值返回 undefined。 */
function normalizeOptionalInteger(value: unknown, label: string, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label}必须在 ${minimum} 到 ${maximum} 之间`);
  }
  return value;
}

function normalizeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new TypeError(`${label}格式无效`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${label}长度无效`);
  return text;
}

function copyInterface(item: AigcInterfaceRecord): AigcInterfaceRecord {
  const config = item.protocol === "openai"
    ? {
        model: (item.config as AigcOpenAiInterfaceConfig).model,
        parameters: resolveOpenAiParameterDefinitions(item.config as AigcOpenAiInterfaceConfig),
      }
    : { ...item.config };
  return {
    ...item,
    config,
  };
}

function normalizeSettings(value: unknown): StoredAigcInterfaces {
  if (!isRecord(value) || !Array.isArray(value.interfaces)) return { interfaces: [] };
  return { interfaces: value.interfaces.filter(isStoredInterface).map(copyInterface) };
}

function isStoredInterface(value: unknown): value is AigcInterfaceRecord {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.description === "string"
    && typeof value.protocol === "string"
    && typeof value.capability === "string"
    && typeof value.channelId === "string"
    && typeof value.enabled === "boolean"
    && typeof value.toolPublishEnabled === "boolean"
    && isRecord(value.config)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
