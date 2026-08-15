import { Readable } from "node:stream";

import type { TtsResponseFormat } from "../../shared/tts-contracts";
import type { TtsCustomParameters } from "../../shared/tts-custom-parameters";
import { isTtsResponseFormat } from "../../shared/tts-custom-parameters";
import { TtsConfigService } from "./tts-config-service";

const MAX_TTS_INPUT_LENGTH = 20_000;
const MAX_TTS_RESPONSE_BYTES = 20 * 1024 * 1024;

/** Agent 在模型级 TTS 请求参数之上提供的个性化覆盖。 */
export interface TtsAgentOverrides {
  voice?: string;
  customParameters?: TtsCustomParameters;
}

/** 通过服务端保存的配置请求 OpenAI 兼容语音合成服务。 */
export class TtsSynthesisService {
  /**
   * @param configs 语音配置读取服务
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(
    private readonly configs: TtsConfigService,
    private readonly request: typeof fetch = fetch,
  ) {}

  /** 合成一段文本，并返回可立即转发给浏览器的音频流。 */
  async synthesize(profileId: string, input: string, signal: AbortSignal, overrides?: TtsAgentOverrides): Promise<{ content: Readable; mediaType: string }> {
    const text = input.trim();
    if (!text || text.length > MAX_TTS_INPUT_LENGTH) throw new TypeError("语音文本长度无效");
    const profile = await this.configs.getPrivate(profileId);
    if (!profile) throw new Error("未找到所选语音配置");
    try {
      const baseRequestBody = {
        model: profile.model,
        voice: profile.voice,
        input: text,
        response_format: profile.responseFormat,
      };
      const requestBody = {
        ...baseRequestBody,
        ...profile.customParameters,
        ...overrides?.customParameters,
        ...(overrides?.voice?.trim() ? { voice: overrides.voice.trim() } : {}),
        // 实际朗读文本始终来自当前请求，配置层不能替换。
        input: text,
      };
      if (!isTtsResponseFormat(requestBody.response_format)) {
        throw new TypeError("TTS 最终 response_format 无效");
      }
      const effectiveFormat = requestBody.response_format;
      const response = await this.request(`${profile.baseUrl}/audio/speech`, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${profile.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) throw new Error("上游服务返回失败状态");
      if (!response.body) throw new Error("上游音频响应为空");
      try {
        assertCompatiblePcmContentType(response.headers.get("content-type"));
        assertContentLength(response.headers.get("content-length"));
      } catch (error) {
        await response.body.cancel().catch(() => undefined);
        throw error;
      }
      return {
        content: await createLimitedAudioStream(response.body),
        mediaType: readAudioMediaType(response.headers.get("content-type"), effectiveFormat),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error("语音合成服务暂时不可用");
    }
  }
}

/**
 * 将 Fetch 响应转为受大小限制的 Node.js 流，避免完整音频落入内存后才发送。
 *
 * @param body 上游 Fetch 音频响应体
 */
async function createLimitedAudioStream(body: ReadableStream<Uint8Array>): Promise<Readable> {
  const reader = body.getReader();
  let firstChunk: Uint8Array | undefined;
  try {
    while (!firstChunk) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("上游音频响应大小无效");
      if (chunk.value.byteLength > 0) firstChunk = chunk.value;
    }
    if (firstChunk.byteLength > MAX_TTS_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("上游音频响应大小无效");
    }
  } catch (error) {
    reader.releaseLock();
    throw error;
  }
  return Readable.from((async function* readChunks() {
    let receivedBytes = firstChunk.byteLength;
    let completed = false;
    try {
      yield Buffer.from(firstChunk);
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          completed = true;
          break;
        }
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > MAX_TTS_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("上游音频响应大小无效");
        }
        if (chunk.value.byteLength > 0) yield Buffer.from(chunk.value);
      }
    } finally {
      if (!completed) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })());
}

/** 拒绝上游预先声明为空或超过响应上限的内容长度。 */
function assertContentLength(value: string | null): void {
  if (value === null) return;
  const length = Number(value);
  if (Number.isSafeInteger(length) && (length === 0 || length > MAX_TTS_RESPONSE_BYTES)) {
    throw new Error("上游音频响应大小无效");
  }
}

/**
 * 校验上游显式声明的裸 PCM 参数；未声明参数时遵循 OpenAI Speech 固定契约。
 */
function assertCompatiblePcmContentType(value: string | null): void {
  if (!value) return;
  const [mediaType, ...parts] = value.split(";").map((part) => part.trim().toLowerCase());
  if (mediaType !== "audio/pcm") return;
  const parameters = new Map(parts.map((part) => {
    const [name, ...rawValue] = part.split("=");
    return [name, rawValue.join("=").replace(/^"|"$/gu, "")] as const;
  }).filter(([name, parameter]) => Boolean(name && parameter)));
  const rate = parameters.get("rate") ?? parameters.get("sample-rate") ?? parameters.get("samplerate");
  const channels = parameters.get("channels") ?? parameters.get("channel-count");
  const bits = parameters.get("bits") ?? parameters.get("bit-depth") ?? parameters.get("bitdepth");
  const format = parameters.get("format");
  if ((rate && rate !== "24000")
    || (channels && channels !== "1" && channels !== "mono")
    || (bits && bits !== "16")
    || (format && !["s16le", "pcm_s16le"].includes(format))) {
    throw new Error("上游 PCM 参数与 OpenAI Speech 规范不兼容");
  }
}

/** 仅接受浏览器可播放的上游媒体类型，其余按请求格式回退。 */
function readAudioMediaType(value: string | null, fallback: TtsResponseFormat): string {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType && mediaType.startsWith("audio/")) return mediaType;
  return fallback === "mp3" ? "audio/mpeg" : fallback === "opus" ? "audio/ogg" : fallback === "wav" ? "audio/wav" : "audio/pcm";
}
