import type {
  AigcChannelConfig,
  AigcComfyUiInputFile,
  AigcWorkflowInputType,
  ComfyUiFieldMetadata,
  ComfyUiNodeMetadataSyncResult,
  ComfyUiNodeTypeMetadata,
} from "../../shared/aigc-contracts";
import type { CredentialService } from "../configuration/credential-service";
import type { AigcConnectionService } from "./aigc-connection-service";

type RequestFunction = typeof fetch;

/** 从 ComfyUI 节点定义中获取 input 目录下的媒体候选文件。 */
export class AigcComfyUiInputService {
  /**
   * @param connections AIGC 渠道配置读取服务
   * @param credentials AIGC 渠道凭证读取服务
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(
    private readonly connections: AigcConnectionService,
    private readonly credentials: CredentialService,
    private readonly request: RequestFunction = fetch,
  ) {}

  /** 读取指定节点字段的 ComfyUI input 文件列表。 */
  async list(channelId: string, nodeClass: string, field: string): Promise<AigcComfyUiInputFile[]> {
    const { channel, apiKey } = await this.resolveChannel(channelId);
    const response = await this.requestNodeInfo(channel, apiKey, nodeClass);
    if (!response.ok) throw new TypeError(`ComfyUI 节点定义读取失败，上游返回 ${response.status}`);
    const payload = await response.json();
    return inputFileOptions(payload, nodeClass, field);
  }

  /** 读取并宽容解析工作流引用的节点定义。 */
  async getNodeMetadata(channelId: string, nodeClasses: string[]): Promise<ComfyUiNodeMetadataSyncResult> {
    const { channel, apiKey } = await this.resolveChannel(channelId);
    const uniqueClasses = [...new Set(nodeClasses.map((item) => item.trim()).filter(Boolean))];
    const metadata: ComfyUiNodeMetadataSyncResult["metadata"] = {};
    const missingNodeClasses: string[] = [];

    // 固定批次并发，避免大型工作流瞬间压满 ComfyUI 请求队列。
    for (let index = 0; index < uniqueClasses.length; index += 6) {
      const batch = uniqueClasses.slice(index, index + 6);
      await Promise.all(batch.map(async (nodeClass) => {
        try {
          const response = await this.requestNodeInfo(channel, apiKey, nodeClass);
          if (!response.ok) throw new TypeError(`上游返回 ${response.status}`);
          const parsed = parseNodeMetadata(await response.json(), nodeClass);
          if (!parsed) throw new TypeError("节点定义格式无效");
          metadata[nodeClass] = parsed;
        } catch {
          missingNodeClasses.push(nodeClass);
        }
      }));
    }

    const syncedNodeClasses = uniqueClasses.filter((nodeClass) => metadata[nodeClass]);
    if (uniqueClasses.length > 0 && syncedNodeClasses.length === 0) throw new TypeError("ComfyUI 节点定义全部读取失败");
    return { metadata, syncedNodeClasses, missingNodeClasses, syncedAt: new Date().toISOString() };
  }

  /** 校验渠道并读取可选凭证。 */
  private async resolveChannel(channelId: string): Promise<{ channel: AigcChannelConfig; apiKey?: string }> {
    const channel = (await this.connections.read()).channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw new TypeError("AIGC 渠道不存在");
    if (channel.type !== "comfyui") throw new TypeError("该渠道不是 ComfyUI");
    return { channel, apiKey: await this.credentials.getApiKey(channel.id) };
  }

  /** 复用统一认证、超时与 URL 编码规则读取节点定义。 */
  private requestNodeInfo(channel: AigcChannelConfig, apiKey: string | undefined, nodeClass: string): Promise<Response> {
    return this.request(`${channel.baseUrl}/object_info/${encodeURIComponent(nodeClass)}`, {
      method: "GET",
      headers: requestHeaders(channel, apiKey),
      signal: channel.timeoutMs === undefined ? undefined : AbortSignal.timeout(Math.max(1_000, channel.timeoutMs)),
    });
  }
}

/** 将单节点或全量 object_info 响应解析为稳定元数据。 */
export function parseNodeMetadata(payload: unknown, nodeClass: string): ComfyUiNodeTypeMetadata | undefined {
  const nodeInfo = nodeInfoFromPayload(payload, nodeClass);
  if (!nodeInfo || !isRecord(nodeInfo.input)) return undefined;
  const fields: Record<string, ComfyUiFieldMetadata> = {};
  for (const [groupName, required] of [["required", true], ["optional", false]] as const) {
    const group = nodeInfo.input[groupName];
    if (!isRecord(group)) continue;
    for (const [name, definition] of Object.entries(group)) {
      const field = parseFieldMetadata(definition, required);
      if (field) fields[`inputs.${name.replace(/^inputs\./u, "")}`] = field;
    }
  }
  return {
    fields,
    ...(typeof nodeInfo.display_name === "string" ? { displayName: nodeInfo.display_name } : {}),
    ...(typeof nodeInfo.description === "string" ? { description: nodeInfo.description } : {}),
    ...(typeof nodeInfo.category === "string" ? { category: nodeInfo.category } : {}),
  };
}

/** 宽容提取 ComfyUI 字段类型、默认值与常见控件约束。 */
function parseFieldMetadata(definition: unknown, required: boolean): ComfyUiFieldMetadata | undefined {
  if (!Array.isArray(definition) || definition.length === 0) return undefined;
  const typeDefinition = definition[0];
  const options = isRecord(definition[1]) ? definition[1] : {};
  const enumOptions = Array.isArray(typeDefinition) ? typeDefinition.filter(isScalar) : undefined;
  const isUploadField = Array.isArray(typeDefinition) && (options.image_upload === true || options.upload === true);
  const comfyType = isUploadField ? "IMAGE" : enumOptions ? "COMBO" : typeof typeDefinition === "string" ? typeDefinition : "";
  if (!comfyType) return undefined;
  const valueType = isUploadField ? "image" : enumOptions ? "enum" : comfyValueType(comfyType, options);
  return {
    comfyType,
    required,
    ...(valueType ? { valueType } : {}),
    ...(isScalar(options.default) ? { defaultValue: options.default } : {}),
    ...(finiteNumber(options.min) !== undefined ? { min: finiteNumber(options.min) } : {}),
    ...(finiteNumber(options.max) !== undefined ? { max: finiteNumber(options.max) } : {}),
    ...(finiteNumber(options.step) !== undefined ? { step: finiteNumber(options.step) } : {}),
    ...(finiteNumber(options.round) !== undefined ? { round: finiteNumber(options.round) } : {}),
    ...(!isUploadField && enumOptions?.length ? { enumOptions } : {}),
    ...(typeof options.tooltip === "string" ? { tooltip: options.tooltip } : {}),
    ...(typeof options.multiline === "boolean" ? { multiline: options.multiline } : {}),
    ...(typeof options.placeholder === "string" ? { placeholder: options.placeholder } : {}),
  };
}

/** 把 ComfyUI 原始类型映射为 BugPaw 入参类型。 */
function comfyValueType(comfyType: string, options: Record<string, unknown>): AigcWorkflowInputType | undefined {
  if (comfyType === "INT") return "int";
  if (comfyType === "FLOAT") return "double";
  if (comfyType === "STRING") return "string";
  if (comfyType === "BOOLEAN") return "bool";
  if (comfyType === "IMAGE" && (options.image_upload === true || options.upload === true)) return "image";
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || finiteNumber(value) !== undefined;
}

/** 生成 ComfyUI 节点定义请求头。 */
function requestHeaders(channel: AigcChannelConfig, apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/** 从 object_info 返回结构中提取目标字段的候选文件。 */
function inputFileOptions(payload: unknown, nodeClass: string, field: string): AigcComfyUiInputFile[] {
  const nodeInfo = nodeInfoFromPayload(payload, nodeClass);
  if (!isRecord(nodeInfo?.input)) return [];
  const fieldName = field.replace(/^inputs\./u, "");
  for (const group of [nodeInfo.input.required, nodeInfo.input.optional]) {
    if (!isRecord(group)) continue;
    for (const [key, value] of Object.entries(group)) {
      const keyName = key.replace(/^inputs\./u, "");
      if (keyName !== fieldName) continue;
      return optionsFromFieldValue(value);
    }
  }
  return [];
}

/** 兼容 object_info 单节点返回和全量返回两种结构。 */
function nodeInfoFromPayload(payload: unknown, nodeClass: string): Record<string, unknown> | undefined {
  if (!isRecord(payload)) return undefined;
  const named = payload[nodeClass];
  if (isRecord(named)) return named;
  if (isRecord(payload.input)) return payload;
  return Object.values(payload).find(isRecord);
}

/** 将 ComfyUI 字段定义中的候选数组归一化为文件摘要。 */
function optionsFromFieldValue(value: unknown): AigcComfyUiInputFile[] {
  const candidates = Array.isArray(value) && Array.isArray(value[0]) ? value[0] : value;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) => {
    const file = normalizeCandidate(candidate);
    return file ? [file] : [];
  });
}

/** 将单个候选值转换为带媒体类型的文件摘要。 */
function normalizeCandidate(value: unknown): AigcComfyUiInputFile | undefined {
  if (typeof value === "string" && value.trim()) {
    return {
      filename: value,
      name: value,
      mediaType: inferMediaType(value),
    };
  }
  if (isRecord(value) && typeof value.filename === "string" && value.filename) {
    const name = typeof value.name === "string" && value.name ? value.name : value.filename;
    return {
      filename: value.filename,
      name,
      mediaType: inferMediaType(value.filename),
      ...(typeof value.subfolder === "string" ? { subfolder: value.subfolder } : {}),
      ...(typeof value.type === "string" ? { type: value.type } : {}),
    };
  }
  return undefined;
}

/** 依据扩展名推断可在浏览器预览的媒体类型。 */
function inferMediaType(fileName: string): string {
  const extension = fileName.split(".").at(-1)?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "mkv", "avi"].includes(extension)) return "video/mp4";
  if (["wav", "mp3", "flac", "ogg", "m4a", "aac"].includes(extension)) return "audio/mpeg";
  if (["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"].includes(extension)) return "image/png";
  return "application/octet-stream";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
