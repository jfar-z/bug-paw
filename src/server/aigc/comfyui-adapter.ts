import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  AigcComfyUiInterfaceConfig,
  AigcWorkflowInputMapping,
  AigcWorkflowOutputMapping,
} from "../../shared/aigc-contracts";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";

const MAX_POLL_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 1_000;

/** 通过 ComfyUI HTTP API 上传入参、提交工作流并收集产物。 */
export class ComfyUiAigcAdapter implements AigcProtocolAdapter {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(private readonly request: typeof fetch = fetch) {}

  /** 执行 ComfyUI 工作流接口。 */
  async execute(input: AigcExecutionInput): Promise<AigcExecutionResult> {
    const config = input.item.config as AigcComfyUiInterfaceConfig;
    const workflow = await input.workflows?.getPrivate(config.workflowId);
    if (!workflow) throw new Error("所选 ComfyUI 工作流不存在");
    const prompt = await this.buildPrompt(workflow.raw, workflow.inputMappings, input);
    const clientId = randomUUID();
    const submitResponse = await this.request(`${input.channel.baseUrl}/prompt`, {
      method: "POST",
      signal: input.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, client_id: clientId }),
    });
    const submitted = await readJson(submitResponse);
    const promptId = readPromptId(submitted);
    const outputs = await this.pollHistory(input, promptId);
    const assets = await this.collectOutputs(input, workflow.outputMappings, outputs);
    if (assets.length === 0) throw new Error("ComfyUI 工作流执行完成但没有可用产物");
    return { assets };
  }

  /** 根据映射生成可执行的 API 格式工作流。 */
  private async buildPrompt(raw: unknown, mappings: AigcWorkflowInputMapping[], input: AigcExecutionInput): Promise<Record<string, unknown>> {
    const apiWorkflow = isUiWorkflow(raw) ? convertUiToApi(raw) : toApiWorkflow(raw);
    for (const mapping of mappings) {
      const value = input.inputs[mapping.name];
      if (value === undefined || value === null || value === "") {
        if (mapping.required) throw new TypeError(`工作流入参 ${mapping.name} 不能为空`);
        continue;
      }
      if (mapping.type === "image" || mapping.type === "video") {
        const uploaded = await this.uploadAsset(input, mapping, value);
        setPath(apiWorkflow, mapping.nodeId, mapping.field, uploaded);
        continue;
      }
      setPath(apiWorkflow, mapping.nodeId, mapping.field, coerceValue(mapping, value));
    }
    return apiWorkflow;
  }

  /** 上传图片或视频文件并返回 ComfyUI 可引用的文件名。 */
  private async uploadAsset(input: AigcExecutionInput, mapping: AigcWorkflowInputMapping, value: unknown): Promise<string> {
    const asset = readAssetReference(value);
    const filePath = await input.assets.resolveInputPath(asset.assetId);
    if (!filePath) throw new TypeError(`工作流入参 ${mapping.name} 的文件不存在`);
    const buffer = await readFile(filePath);
    const form = new FormData();
    const file = new Blob([buffer], { type: asset.mediaType || (mapping.type === "video" ? "video/mp4" : "image/png") });
    form.set("image", file, asset.name || basename(filePath));
    const endpoint = mapping.type === "video" ? "/upload/image" : "/upload/image";
    const response = await this.request(`${input.channel.baseUrl}${endpoint}`, {
      method: "POST",
      signal: input.signal,
      body: form,
    });
    const payload = await readJson(response);
    if (typeof payload.name !== "string" || !payload.name) throw new Error("ComfyUI 上传响应缺少文件名");
    return payload.name;
  }

  /** 轮询 ComfyUI history 直到出现指定 prompt_id。 */
  private async pollHistory(input: AigcExecutionInput, promptId: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt += 1) {
      if (input.signal.aborted) throw new Error("任务已取消");
      const response = await this.request(`${input.channel.baseUrl}/history/${encodeURIComponent(promptId)}`, {
        signal: input.signal,
        headers: { Accept: "application/json" },
      });
      const payload = await readJson(response);
      const entry = payload[promptId];
      if (isRecord(entry)) {
        if (isRecord(entry.status) && entry.status.status_str === "error") throw new Error("ComfyUI 工作流执行失败");
        if (isRecord(entry.outputs)) return entry;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error("ComfyUI 工作流执行超时");
  }

  /** 按输出映射下载或提取产物。 */
  private async collectOutputs(
    input: AigcExecutionInput,
    mappings: AigcWorkflowOutputMapping[],
    history: Record<string, unknown>,
  ) {
    const outputs = isRecord(history.outputs) ? history.outputs : {};
    const assets = [];
    for (const mapping of mappings) {
      const nodeOutput = outputs[mapping.nodeId];
      if (!isRecord(nodeOutput)) continue;
      const value = nodeOutput[fieldBaseName(mapping.field)] ?? nodeOutput[mapping.field.replace("outputs.", "")];
      if (mapping.mediaType === "text") {
        const text = Array.isArray(value) ? value.map(String).join("") : value;
        if (text) assets.push({ name: `${mapping.name || "output"}.txt`, mediaType: "text/plain", content: Buffer.from(String(text), "utf8") });
        continue;
      }
      if (mapping.mediaType === "json") {
        if (value !== undefined) assets.push({ name: `${mapping.name || "output"}.json`, mediaType: "application/json", content: Buffer.from(JSON.stringify(value), "utf8") });
        continue;
      }
      const list = mediaArray(value, mapping.mediaType);
      for (const file of list) {
        if (!isRecord(file) || typeof file.filename !== "string") continue;
        const url = new URL(`${input.channel.baseUrl}/view`);
        url.searchParams.set("filename", file.filename);
        if (typeof file.subfolder === "string") url.searchParams.set("subfolder", file.subfolder);
        if (typeof file.type === "string") url.searchParams.set("type", file.type);
        const downloaded = await download(this.request, url.toString(), input.signal);
        assets.push({
          name: file.filename,
          mediaType: mapping.mediaType === "video" ? "video/mp4" : "image/png",
          content: downloaded,
        });
      }
    }
    return assets;
  }
}

/** 判断当前 raw 是否为 UI 导出格式。 */
function isUiWorkflow(raw: unknown): raw is Record<string, unknown> & { nodes: unknown[]; links?: unknown[] } {
  return isRecord(raw) && Array.isArray(raw.nodes);
}

/** 将 API 格式对象复制为可写结构。 */
function toApiWorkflow(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new TypeError("ComfyUI 工作流格式无效");
  return structuredClone(raw);
}

/** 将 UI 导出格式转换为 API 格式。 */
function convertUiToApi(raw: Record<string, unknown> & { nodes: unknown[]; links?: unknown[] }): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const value of raw.nodes) {
    if (!isRecord(value)) continue;
    const node: Record<string, unknown> = { class_type: value.type ?? "unknown", inputs: {} };
    if (Array.isArray(value.widgets_values)) {
      const widgetNames = widgetInputNames(String(value.type));
      value.widgets_values.forEach((widget, index) => {
        const name = widgetNames[index] ?? `widgets_values_${index}`;
        (node.inputs as Record<string, unknown>)[name] = widget;
      });
    }
    api[String(value.id)] = node;
    nodeById.set(String(value.id), value);
  }
  if (Array.isArray(raw.links)) {
    for (const link of raw.links) {
      if (!Array.isArray(link) || link.length < 5) continue;
      const [, sourceId, sourceSlot, targetId, targetSlot] = link;
      const targetNode = api[String(targetId)];
      const sourceNode = nodeById.get(String(sourceId));
      const target = nodeById.get(String(targetId));
      const targetName = uiInputName(target, Number(targetSlot));
      if (isRecord(targetNode) && isRecord(targetNode.inputs)) {
        (targetNode.inputs as Record<string, unknown>)[targetName] = [String(sourceId), Number(sourceSlot)];
      }
      void sourceNode;
    }
  }
  return api;
}

/** 根据 UI 节点类型返回常见 widget 到 API 入参名的映射。 */
function widgetInputNames(type: string): string[] {
  const normalized = type.toLowerCase();
  if (normalized.includes("ksampler")) return ["seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"];
  if (normalized.includes("cliptextencode")) return ["text"];
  if (normalized.includes("emptylatentimage")) return ["width", "height", "batch_size"];
  if (normalized.includes("checkpointloadersimple")) return ["ckpt_name"];
  if (normalized.includes("loadimage")) return ["image"];
  if (normalized.includes("saveimage")) return ["filename_prefix"];
  return [];
}

function uiInputName(node: Record<string, unknown> | undefined, slot: number): string {
  if (!isRecord(node) || !Array.isArray(node.inputs)) return `slot_${slot}`;
  const field = node.inputs[slot];
  return isRecord(field) && typeof field.name === "string" ? field.name : `slot_${slot}`;
}

/** 将字段路径写入 API 工作流节点。 */
function setPath(workflow: Record<string, unknown>, nodeId: string, field: string, value: unknown): void {
  const node = workflow[nodeId];
  if (!isRecord(node) || !isRecord(node.inputs)) throw new TypeError(`工作流节点 ${nodeId} 不存在`);
  const base = field.replace(/^(inputs|widgets_values)\./, "");
  node.inputs[base] = value;
}

/** 读取字段路径末尾名称。 */
function fieldBaseName(field: string): string {
  return field.replace(/^outputs\./, "");
}

function coerceValue(mapping: AigcWorkflowInputMapping, value: unknown): unknown {
  if (mapping.type === "bool" && typeof value === "boolean") return value;
  if ((mapping.type === "int" || mapping.type === "double") && typeof value === "number" && Number.isFinite(value)) return value;
  if (mapping.type === "string" || mapping.type === "enum") return String(value);
  return value;
}

function readAssetReference(value: unknown): { assetId: string; name?: string; mediaType?: string } {
  if (!isRecord(value) || typeof value.assetId !== "string" || !value.assetId) throw new TypeError("图片或视频入参格式无效");
  return {
    assetId: value.assetId,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
  };
}

function mediaArray(value: unknown, mediaType: "image" | "video"): unknown[] {
  if (Array.isArray(value)) return value;
  if (mediaType === "video" && isRecord(value) && Array.isArray(value.videos)) return value.videos;
  if (mediaType === "video" && isRecord(value) && Array.isArray(value.gifs)) return value.gifs;
  if (mediaType === "image" && isRecord(value) && Array.isArray(value.images)) return value.images;
  return [];
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(`ComfyUI 返回 ${response.status}`);
  if (!isRecord(payload)) throw new Error("ComfyUI 响应格式无效");
  return payload;
}

function readPromptId(payload: Record<string, unknown>): string {
  if (typeof payload.prompt_id !== "string" || !payload.prompt_id) throw new Error("ComfyUI 提交响应缺少 prompt_id");
  return payload.prompt_id;
}

async function download(request: typeof fetch, url: string, signal: AbortSignal): Promise<Buffer> {
  const response = await request(url, { signal });
  if (!response.ok) throw new Error(`产物下载失败 ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
