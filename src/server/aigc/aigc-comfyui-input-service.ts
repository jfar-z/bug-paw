import type { AigcChannelConfig, AigcComfyUiInputFile } from "../../shared/aigc-contracts";
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
    const channel = (await this.connections.read()).channels.find((candidate) => candidate.id === channelId);
    if (!channel) throw new TypeError("AIGC 渠道不存在");
    if (channel.type !== "comfyui") throw new TypeError("该渠道不是 ComfyUI");
    const apiKey = await this.credentials.getApiKey(channel.id);
    const response = await this.request(`${channel.baseUrl}/object_info/${encodeURIComponent(nodeClass)}`, {
      method: "GET",
      headers: requestHeaders(channel, apiKey),
      signal: channel.timeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(Math.max(1_000, channel.timeoutMs)),
    });
    if (!response.ok) throw new TypeError(`ComfyUI 节点定义读取失败，上游返回 ${response.status}`);
    const payload = await response.json();
    return inputFileOptions(payload, nodeClass, field);
  }
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
