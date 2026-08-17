import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { AigcGrokInterfaceConfig } from "../../shared/aigc-contracts";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";

/** 通过 xAI Grok 标准接口执行图像与视频生成。 */
export class GrokAigcAdapter implements AigcProtocolAdapter {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(private readonly request: typeof fetch = fetch) {}

  /** 按能力路由到图片或视频生成端点。 */
  async execute(input: AigcExecutionInput): Promise<AigcExecutionResult> {
    const config = input.item.config as AigcGrokInterfaceConfig;
    const prompt = readPrompt(input.inputs.prompt);
    const isVideo = input.item.capability === "text-to-video" || input.item.capability === "image-to-video";
    const endpoint = isVideo ? "videos/generations" : "images/generations";
    let requestBody: BodyInit;
    let requestHeaders: Record<string, string>;
    if (input.item.capability === "image-to-video") {
      const image = readAsset(input.inputs.image);
      const imagePath = await input.assets.resolveInputPath(image.assetId);
      if (!imagePath) throw new Error("图片入参文件不存在");
      const imageBuffer = await readFile(imagePath);
      const form = new FormData();
      form.set("model", config.model);
      form.set("prompt", prompt);
      form.set("image", new Blob([imageBuffer], { type: image.mediaType || "application/octet-stream" }), image.name || basename(imagePath));
      requestBody = form;
      requestHeaders = authHeaders(input.apiKey);
    } else {
      requestBody = JSON.stringify({ model: config.model, prompt });
      requestHeaders = jsonHeaders(input.apiKey);
    }
    const response = await this.request(`${input.channel.baseUrl}/${endpoint}`, {
      method: "POST",
      signal: input.signal,
      headers: requestHeaders,
      body: requestBody,
    });
    const payload = await readJson(response);
    const data = readGeneratedData(payload);
    if (typeof data.b64_json === "string" && data.b64_json) {
      return {
        assets: [{
          name: `grok-${input.item.id}.${isVideo ? "mp4" : "png"}`,
          mediaType: isVideo ? "video/mp4" : "image/png",
          content: Buffer.from(data.b64_json, "base64"),
        }],
      };
    }
    if (typeof data.url === "string" && data.url) {
      const downloaded = await download(this.request, data.url, input.signal);
      return {
        assets: [{
          name: `grok-${input.item.id}.${isVideo ? "mp4" : "png"}`,
          mediaType: isVideo ? "video/mp4" : "image/png",
          content: downloaded,
        }],
      };
    }
    throw new Error("Grok 响应缺少可用产物");
  }
}

/** 构造 JSON 请求认证头。 */
function jsonHeaders(apiKey?: string): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders(apiKey) };
}

/** 构造不干扰 multipart 自动边界的认证头。 */
function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`上游服务返回 ${response.status}`);
  if (!isRecord(payload)) throw new Error("上游响应格式无效");
  return payload;
}

function readGeneratedData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = Array.isArray(payload.data) ? payload.data[0] : undefined;
  if (!isRecord(data)) throw new Error("上游响应缺少 data");
  return data;
}

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
