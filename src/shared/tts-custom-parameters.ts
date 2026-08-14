import type { TtsResponseFormat } from "./tts-contracts";

/** TTS 请求体中允许由配置扩展的 JSON 参数。 */
export type TtsCustomParameters = Record<string, unknown>;

/** 单层 TTS 自定义参数允许占用的最大 UTF-8 字节数。 */
export const TTS_CUSTOM_PARAMETERS_MAX_BYTES = 16 * 1024;

/**
 * 判断返回格式是否受当前浏览器播放与服务端响应处理支持。
 *
 * @param value 待判断的返回格式
 */
export function isTtsResponseFormat(value: unknown): value is TtsResponseFormat {
  return value === "mp3" || value === "opus" || value === "wav" || value === "pcm";
}

/**
 * 严格校验并复制用户提交的 TTS 自定义参数。
 *
 * @param value 浏览器或内部调用方提交的未知值
 */
export function normalizeTtsCustomParameters(value: unknown): TtsCustomParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("TTS 自定义请求参数必须是 JSON 对象");
  }
  const parameters = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(parameters, "input")) {
    throw new TypeError("TTS 自定义请求参数不能覆盖 input");
  }
  if (parameters.response_format !== undefined && !isTtsResponseFormat(parameters.response_format)) {
    throw new TypeError("TTS 自定义请求参数 response_format 无效");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(parameters);
  } catch {
    throw new TypeError("TTS 自定义请求参数必须可序列化为 JSON");
  }
  if (new TextEncoder().encode(serialized).byteLength > TTS_CUSTOM_PARAMETERS_MAX_BYTES) {
    throw new TypeError("TTS 自定义请求参数不能超过 16 KiB");
  }
  return JSON.parse(serialized) as TtsCustomParameters;
}

/**
 * 宽容读取历史配置；非法扩展字段不会阻断整个语音配置加载。
 *
 * @param value 持久化记录中的未知值
 */
export function readTtsCustomParameters(value: unknown): TtsCustomParameters {
  if (value === undefined) return {};
  try {
    return normalizeTtsCustomParameters(value);
  } catch {
    return {};
  }
}
