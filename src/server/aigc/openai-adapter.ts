import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { AigcOpenAiInterfaceConfig } from "../../shared/aigc-contracts";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";

/** 通过 OpenAI 标准接口执行文生图与图片编辑。 */
export class OpenAiAigcAdapter implements AigcProtocolAdapter {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(private readonly request: typeof fetch = fetch) {}

  /** 执行 OpenAI 图像生成接口。 */
  async execute(input: AigcExecutionInput): Promise<AigcExecutionResult> {
    const config = input.item.config as AigcOpenAiInterfaceConfig;
    const prompt = readPrompt(input.inputs.prompt);
    if (input.item.capability === "image-edit") {
      return this.editImage(input, config, prompt);
    }
    return this.generateImage(input, config, prompt);
  }

  /** 文生图：优先解析 base64，其次下载响应 URL。 */
  private async generateImage(
    input: AigcExecutionInput,
    config: AigcOpenAiInterfaceConfig,
    prompt: string,
  ): Promise<AigcExecutionResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      prompt,
      ...(config.size ? { size: config.size } : {}),
      ...(config.quality ? { quality: config.quality } : {}),
      ...(config.responseFormat ? { response_format: config.responseFormat } : {}),
    };
    const response = await this.request(`${input.channel.baseUrl}/images/generations`, {
      method: "POST",
      signal: input.signal,
      headers: headers(input.apiKey),
      body: JSON.stringify(body),
    });
    const payload = await readJson(response);
    const data = readImageData(payload);
    if (typeof data.b64_json === "string" && data.b64_json) {
      return { assets: [{ name: `openai-${input.item.id}.png`, mediaType: "image/png", content: Buffer.from(data.b64_json, "base64") }] };
    }
    if (typeof data.url === "string" && data.url) {
      return { assets: [{ name: `openai-${input.item.id}.png`, mediaType: "image/png", content: await download(this.request, data.url, input.signal) }] };
    }
    throw new Error("OpenAI 图像响应缺少可用产物");
  }

  /** 图片编辑：将入参图片作为 multipart 文件提交。 */
  private async editImage(
    input: AigcExecutionInput,
    config: AigcOpenAiInterfaceConfig,
    prompt: string,
  ): Promise<AigcExecutionResult> {
    const image = readAsset(input.inputs.image);
    const imagePath = await input.assets.resolveInputPath(image.assetId);
    if (!imagePath) throw new Error("图片入参文件不存在");
    const imageBuffer = await readFile(imagePath);
    const form = new FormData();
    form.set("model", config.model);
    form.set("prompt", prompt);
    form.set("image", new Blob([imageBuffer], { type: image.mediaType || "application/octet-stream" }), image.name || basename(imagePath));
    const response = await this.request(`${input.channel.baseUrl}/images/edits`, {
      method: "POST",
      signal: input.signal,
      headers: authHeaders(input.apiKey),
      body: form,
    });
    const payload = await readJson(response);
    const data = readImageData(payload);
    if (typeof data.b64_json === "string" && data.b64_json) {
      return { assets: [{ name: `openai-edit-${input.item.id}.png`, mediaType: "image/png", content: Buffer.from(data.b64_json, "base64") }] };
    }
    if (typeof data.url === "string" && data.url) {
      return { assets: [{ name: `openai-edit-${input.item.id}.png`, mediaType: "image/png", content: await download(this.request, data.url, input.signal) }] };
    }
    throw new Error("OpenAI 图片编辑响应缺少可用产物");
  }
}

/** 构造 JSON 请求认证头。 */
function headers(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...authHeaders(apiKey),
  };
}

/** 构造不干扰 multipart 自动边界的认证头。 */
function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 读取并解析上游 JSON，失败时统一脱敏。 */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`上游服务返回 ${response.status}`);
  if (!isRecord(payload)) throw new Error("上游响应格式无效");
  return payload;
}

function readImageData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = Array.isArray(payload.data) ? payload.data[0] : undefined;
  if (!isRecord(data)) throw new Error("上游图像响应缺少 data");
  return data;
}

/** 下载响应 URL，限制为图片产物字节。 */
async function download(request: typeof fetch, url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await request(url, { signal });
  if (!response.ok) throw new Error(`产物下载失败 ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function readPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("prompt 不能为空");
  return value.trim();
}

function readAsset(value: unknown): { assetId: string; name?: string; mediaType?: string } {
  if (!isRecord(value) || typeof value.assetId !== "string" || !value.assetId) throw new TypeError("缺少图片或视频入参");
  return {
    assetId: value.assetId,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
