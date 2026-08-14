import type { TtsCustomParameters } from "../shared/tts-custom-parameters";
import { normalizeTtsCustomParameters } from "../shared/tts-custom-parameters";

/**
 * 把结构化参数格式化为适合表单编辑的 JSON。
 *
 * @param value 已保存的自定义参数
 */
export function formatTtsCustomParameters(value: TtsCustomParameters | undefined): string {
  return JSON.stringify(value ?? {}, null, 2);
}

/**
 * 解析并校验用户在表单中编辑的 JSON 参数。
 *
 * @param text JSON 文本草稿
 */
export function parseTtsCustomParametersText(text: string): TtsCustomParameters {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TypeError("TTS 自定义请求参数必须是有效的 JSON");
  }
  return normalizeTtsCustomParameters(parsed);
}
