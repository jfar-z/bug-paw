import type { TtsCustomParameters } from "./tts-custom-parameters";

/** 支持的 OpenAI 兼容语音响应格式。 */
export type TtsResponseFormat = "mp3" | "opus" | "wav" | "pcm";

/** 可安全返回给浏览器的语音配置摘要。 */
export interface TtsProfileSummary {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  voice: string;
  responseFormat: TtsResponseFormat;
  customParameters: TtsCustomParameters;
  hasApiKey: boolean;
}

/** 浏览器提交的语音配置字段。 */
export interface TtsProfileInput {
  name: string;
  baseUrl: string;
  model: string;
  voice: string;
  responseFormat: TtsResponseFormat;
  customParameters?: TtsCustomParameters;
  /** 空字符串表示更新时保留已保存的密钥。 */
  apiKey: string;
}

/** 带乐观锁版本的语音配置列表。 */
export interface TtsSettingsDocument {
  revision: string;
  profiles: TtsProfileSummary[];
}
