const DEFAULT_TIMEOUT_MS = 120_000;

/** Whisper 服务返回的稳定转写结果。 */
export interface WhisperTranscription {
  text: string;
  language: string;
  duration: number;
}

/** 调用同一 Compose 网络中的本机 Whisper 服务。 */
export class WhisperClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  /** 上传一段录音并返回清理后的识别文本。 */
  async transcribe(audio: Buffer, filename: string, mediaType: string): Promise<WhisperTranscription> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const form = new FormData();
      form.append("audio", new Blob([Uint8Array.from(audio)], { type: mediaType }), filename);
      const response = await fetch(new URL("/v1/transcriptions", this.baseUrl), {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Whisper 服务返回 ${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      if (typeof payload.text !== "string"
        || typeof payload.language !== "string"
        || typeof payload.duration !== "number") {
        throw new Error("Whisper 服务响应格式无效");
      }
      return {
        text: payload.text.trim(),
        language: payload.language,
        duration: payload.duration,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
