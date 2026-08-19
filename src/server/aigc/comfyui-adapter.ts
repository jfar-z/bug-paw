import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type {
  AigcComfyUiInterfaceConfig,
  AigcTaskExecutionPhase,
  AigcTaskExecutionState,
  AigcWorkflowDetail,
  AigcWorkflowInputMapping,
  AigcWorkflowOutputMapping,
} from "../../shared/aigc-contracts";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";

const POLL_INTERVAL_MS = 1_000;
const QUEUE_POLL_EVERY = 3;

interface ComfyWebSocket {
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  close(): void;
}

type ComfyWebSocketFactory = (url: string) => ComfyWebSocket | undefined;

/** 通过 ComfyUI HTTP API 上传入参、提交工作流并收集产物。 */
export class ComfyUiAigcAdapter implements AigcProtocolAdapter {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(
    private readonly request: typeof fetch = fetch,
    private readonly createSocket: ComfyWebSocketFactory = defaultSocketFactory,
    private readonly pollIntervalMs: number = POLL_INTERVAL_MS,
  ) {}

  /** 执行 ComfyUI 工作流接口。 */
  async execute(input: AigcExecutionInput): Promise<AigcExecutionResult> {
    const config = input.item.config as AigcComfyUiInterfaceConfig;
    const workflow = await input.workflows?.getPrivate(config.workflowId);
    if (!workflow) throw new Error("所选 ComfyUI 工作流不存在");
    const progress = createProgressReporter(input, workflow);
    if (workflow.inputMappings.some((mapping) => ["image", "video", "audio"].includes(mapping.type))) {
      progress.phase("uploading");
    }
    const prompt = await this.buildPrompt(workflow.raw, workflow.inputMappings, input);
    const clientId = randomUUID();
    const tracker = this.openStatusSocket(input.channel.baseUrl, clientId, progress);
    try {
      progress.phase("submitting");
      const submitResponse = await this.request(`${input.channel.baseUrl}/prompt`, {
        method: "POST",
        signal: requestSignal(input.signal, input.channel.timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
      });
      const submitted = await readJson(submitResponse);
      const promptId = readPromptId(submitted);
      tracker?.setPromptId(promptId);
      progress.queue(0);
      const outputs = await this.pollHistory(input, promptId, progress);
      progress.phase("downloading");
      const assets = await this.collectOutputs(input, workflow.outputMappings, outputs);
      if (assets.length === 0) throw new Error("ComfyUI 工作流执行完成但没有可用产物");
      return { assets };
    } finally {
      tracker?.close();
    }
  }

  /** 根据映射生成可执行的 API 格式工作流。 */
  private async buildPrompt(raw: unknown, mappings: AigcWorkflowInputMapping[], input: AigcExecutionInput): Promise<Record<string, unknown>> {
    const apiWorkflow = isUiWorkflow(raw) ? convertUiToApi(raw) : toApiWorkflow(raw);
    const removedNodeIds = new Set<string>();
    for (const mapping of mappings) {
      const value = input.inputs[mapping.name];
      if (value === undefined || value === null || value === "") {
        if (mapping.required) throw new TypeError(`工作流入参 ${mapping.name} 不能为空`);
        for (const nodeId of mapping.activation?.nodeIds ?? []) removedNodeIds.add(nodeId);
        continue;
      }
      if (mapping.type === "image" || mapping.type === "video" || mapping.type === "audio") {
        const uploaded = await this.uploadAsset(input, mapping, value);
        setPath(apiWorkflow, mapping.nodeId, mapping.field, uploaded);
        continue;
      }
      setPath(apiWorkflow, mapping.nodeId, mapping.field, coerceValue(mapping, value));
    }
    pruneConditionalNodes(apiWorkflow, removedNodeIds);
    return apiWorkflow;
  }

  /** 上传图片、视频或音频文件并返回 ComfyUI 可引用的文件名。 */
  private async uploadAsset(input: AigcExecutionInput, mapping: AigcWorkflowInputMapping, value: unknown): Promise<string> {
    const asset = readAssetReference(value);
    const filePath = await input.assets.resolveInputPath(asset.assetId);
    if (!filePath) throw new TypeError(`工作流入参 ${mapping.name} 的文件不存在`);
    const buffer = await readFile(filePath);
    const form = new FormData();
    const fallbackMediaType = mapping.type === "video" ? "video/mp4" : mapping.type === "audio" ? "audio/mpeg" : "image/png";
    const file = new Blob([buffer], { type: asset.mediaType || fallbackMediaType });
    form.set("image", file, asset.name || basename(filePath));
    // ComfyUI 使用同一上传入口把通用媒体文件写入 input 目录。
    const response = await this.request(`${input.channel.baseUrl}/upload/image`, {
      method: "POST",
      signal: requestSignal(input.signal, input.channel.timeoutMs),
      body: form,
    });
    const payload = await readJson(response);
    if (typeof payload.name !== "string" || !payload.name) throw new Error("ComfyUI 上传响应缺少文件名");
    return payload.name;
  }

  /** 轮询 ComfyUI history 直到出现指定 prompt_id。 */
  private async pollHistory(
    input: AigcExecutionInput,
    promptId: string,
    progress: ExecutionProgressReporter,
  ): Promise<Record<string, unknown>> {
    let attempt = 0;
    while (true) {
      if (input.signal.aborted) throw new Error("任务已取消");
      if (attempt % QUEUE_POLL_EVERY === 0) {
        await this.refreshQueueState(input, promptId, progress);
      }
      const response = await this.request(`${input.channel.baseUrl}/history/${encodeURIComponent(promptId)}`, {
        signal: requestSignal(input.signal, input.channel.timeoutMs),
        headers: { Accept: "application/json" },
      });
      const payload = await readJson(response);
      const entry = payload[promptId];
      if (isRecord(entry)) {
        if (isRecord(entry.status) && entry.status.status_str === "error") throw new Error("ComfyUI 工作流执行失败");
        if (isRecord(entry.outputs)) return entry;
      }
      attempt += 1;
      await sleep(this.pollIntervalMs, input.signal);
    }
  }

  /** 使用队列接口补充 WebSocket 断线时的排队状态。 */
  private async refreshQueueState(
    input: AigcExecutionInput,
    promptId: string,
    progress: ExecutionProgressReporter,
  ): Promise<void> {
    try {
      const response = await this.request(`${input.channel.baseUrl}/queue`, {
        signal: requestSignal(input.signal, input.channel.timeoutMs),
        headers: { Accept: "application/json" },
      });
      const payload = await readJson(response);
      const pending = Array.isArray(payload.queue_pending) ? payload.queue_pending : [];
      const queueIndex = pending.findIndex((entry) => Array.isArray(entry) && String(entry[1]) === promptId);
      if (queueIndex >= 0) {
        progress.queue(queueIndex);
        return;
      }
      const running = Array.isArray(payload.queue_running) ? payload.queue_running : [];
      if (running.some((entry) => Array.isArray(entry) && String(entry[1]) === promptId)) progress.phase("running");
    } catch (error) {
      if (input.signal.aborted) throw error;
      // 队列信息仅用于增强展示，读取失败时继续依赖 history。
    }
  }

  /** 建立节点级事件订阅；连接失败时由 history 轮询兜底。 */
  private openStatusSocket(baseUrl: string, clientId: string, progress: ExecutionProgressReporter) {
    let socket: ComfyWebSocket | undefined;
    try {
      socket = this.createSocket(comfyWebSocketUrl(baseUrl, clientId));
    } catch {
      return undefined;
    }
    if (!socket) return undefined;
    let promptId = "";
    const buffered: unknown[] = [];
    const consume = (value: unknown) => {
      if (!promptId) {
        if (buffered.length < 100) buffered.push(value);
        return;
      }
      consumeSocketMessage(value, promptId, progress);
    };
    socket.addEventListener("message", (event) => consume(event.data));
    return {
      setPromptId(value: string) {
        promptId = value;
        for (const message of buffered.splice(0)) consumeSocketMessage(message, promptId, progress);
      },
      close() {
        socket?.close();
      },
    };
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
      const list = mediaArray(value, mapping.mediaType, nodeOutput);
      for (const file of list) {
        if (!isRecord(file) || typeof file.filename !== "string") continue;
        const url = new URL(`${input.channel.baseUrl}/view`);
        url.searchParams.set("filename", file.filename);
        if (typeof file.subfolder === "string") url.searchParams.set("subfolder", file.subfolder);
        if (typeof file.type === "string") url.searchParams.set("type", file.type);
        const downloaded = await download(this.request, url.toString(), requestSignal(input.signal, input.channel.timeoutMs));
        assets.push({
          name: file.filename,
          mediaType: outputMediaType(mapping.mediaType, file.filename),
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

/** 删除未启用的条件节点，并清理剩余节点指向它们的输入连接。 */
function pruneConditionalNodes(workflow: Record<string, unknown>, removedNodeIds: Set<string>): void {
  if (removedNodeIds.size === 0) return;
  for (const nodeId of removedNodeIds) delete workflow[nodeId];
  for (const node of Object.values(workflow)) {
    if (!isRecord(node) || !isRecord(node.inputs)) continue;
    for (const [field, value] of Object.entries(node.inputs)) {
      if (isNodeConnection(value) && removedNodeIds.has(String(value[0]))) delete node.inputs[field];
    }
  }
}

/** 判断 ComfyUI API Prompt 中的单条节点连接。 */
function isNodeConnection(value: unknown): value is [string | number, number] {
  return Array.isArray(value)
    && value.length >= 2
    && (typeof value[0] === "string" || typeof value[0] === "number")
    && typeof value[1] === "number";
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
  if (!isRecord(value) || typeof value.assetId !== "string" || !value.assetId) throw new TypeError("媒体入参格式无效");
  return {
    assetId: value.assetId,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
  };
}

/** 将 ComfyUI 节点输出归一化为可下载的文件描述数组。 */
function mediaArray(value: unknown, mediaType: "image" | "video" | "audio", nodeOutput?: Record<string, unknown>): unknown[] {
  const sources = [value, nodeOutput].filter(isRecord);
  const bucketNames = mediaBucketNames(mediaType);
  for (const source of sources) {
    for (const bucketName of bucketNames) {
      const bucket = source[bucketName];
      const files = mediaBucketFiles(bucket).filter((file) => isMediaFile(file, mediaType));
      if (files.length > 0) return files;
    }
  }
  if (Array.isArray(value)) return value.filter((file) => isMediaFile(file, mediaType));
  return [];
}

/** 返回按媒体类型排序的 ComfyUI UI 输出桶名称。 */
function mediaBucketNames(mediaType: "image" | "video" | "audio"): string[] {
  if (mediaType === "audio") return ["audio", "audios"];
  if (mediaType === "video") return ["videos", "gifs", "images"];
  return ["images"];
}

/** 将单个输出桶转换为扁平的文件描述数组。 */
function mediaBucketFiles(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    if (typeof value.filename === "string") return [value];
    return Object.values(value).flatMap((entry) => mediaBucketFiles(entry));
  }
  return [];
}

/** 依据文件名扩展判断该输出描述是否符合目标媒体类型。 */
function isMediaFile(file: unknown, mediaType: "image" | "video" | "audio"): boolean {
  if (!isRecord(file) || typeof file.filename !== "string") return false;
  const normalized = file.filename.toLowerCase();
  const extensions = mediaFileExtensions(mediaType);
  return extensions.some((extension) => normalized.endsWith(extension));
}

/** 返回各类媒体可识别的文件扩展名。 */
function mediaFileExtensions(mediaType: "image" | "video" | "audio"): string[] {
  if (mediaType === "video") return [".mp4", ".webm", ".mov", ".mkv", ".avi"];
  if (mediaType === "audio") return [".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac"];
  return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"];
}

function outputMediaType(kind: "image" | "video" | "audio", fileName: string): string {
  if (kind === "video") return "video/mp4";
  if (kind === "image") return "image/png";
  const normalized = fileName.toLowerCase();
  if (normalized.endsWith(".wav")) return "audio/wav";
  if (normalized.endsWith(".flac")) return "audio/flac";
  if (normalized.endsWith(".ogg") || normalized.endsWith(".oga")) return "audio/ogg";
  if (normalized.endsWith(".m4a")) return "audio/mp4";
  return "audio/mpeg";
}

interface ExecutionProgressReporter {
  phase(phase: AigcTaskExecutionPhase): void;
  queue(ahead: number): void;
  executing(nodeId: string): void;
  nodeProgress(nodeId: string, value: number, maximum: number): void;
  completed(nodeIds: string[]): void;
}

/** 将 ComfyUI 节点事件归一化为稳定且紧凑的任务进度。 */
function createProgressReporter(input: AigcExecutionInput, workflow: AigcWorkflowDetail): ExecutionProgressReporter {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const completedNodes = new Set<string>();
  let state: AigcTaskExecutionState = stamp({ phase: "submitting", totalNodes: workflow.nodes.length });
  const emit = (next: Omit<AigcTaskExecutionState, "updatedAt">) => {
    state = stamp(next);
    input.onProgress?.({ ...state });
  };
  const nodeState = (nodeId: string) => {
    const node = nodes.get(nodeId);
    return {
      currentNodeId: nodeId,
      ...(node?.title || node?.type ? { currentNodeName: node.title || node.type } : {}),
      ...(node?.type ? { currentNodeType: node.type } : {}),
    };
  };
  return {
    phase(phase) {
      if (phase === "running" && state.phase === "running") return;
      emit({ phase, totalNodes: workflow.nodes.length, completedNodes: completedNodes.size });
    },
    queue(ahead) {
      if (state.phase === "running" && state.currentNodeId) return;
      emit({ phase: "queued", queueAhead: Math.max(0, ahead), totalNodes: workflow.nodes.length, completedNodes: completedNodes.size });
    },
    executing(nodeId) {
      emit({ phase: "running", ...nodeState(nodeId), totalNodes: workflow.nodes.length, completedNodes: completedNodes.size });
    },
    nodeProgress(nodeId, value, maximum) {
      emit({
        phase: "running",
        ...nodeState(nodeId),
        progressValue: Math.max(0, value),
        progressMax: Math.max(0, maximum),
        totalNodes: workflow.nodes.length,
        completedNodes: completedNodes.size,
      });
    },
    completed(nodeIds) {
      for (const nodeId of nodeIds) completedNodes.add(nodeId);
      emit({
        phase: state.phase === "queued" ? "running" : state.phase,
        ...(state.currentNodeId ? nodeState(state.currentNodeId) : {}),
        ...(state.progressValue !== undefined ? { progressValue: state.progressValue } : {}),
        ...(state.progressMax !== undefined ? { progressMax: state.progressMax } : {}),
        totalNodes: workflow.nodes.length,
        completedNodes: completedNodes.size,
      });
    },
  };
}

function stamp(state: Omit<AigcTaskExecutionState, "updatedAt">): AigcTaskExecutionState {
  return { ...state, updatedAt: new Date().toISOString() };
}

/** 消费 ComfyUI 文本事件；二进制预览帧由正式产物下载链处理。 */
function consumeSocketMessage(value: unknown, promptId: string, progress: ExecutionProgressReporter): void {
  if (typeof value !== "string") return;
  let message: unknown;
  try {
    message = JSON.parse(value);
  } catch {
    return;
  }
  if (!isRecord(message) || typeof message.type !== "string" || !isRecord(message.data)) return;
  const data = message.data;
  if (typeof data.prompt_id === "string" && data.prompt_id !== promptId) return;
  if (message.type === "execution_start") {
    progress.phase("running");
    return;
  }
  if (message.type === "execution_cached" && Array.isArray(data.nodes)) {
    progress.completed(data.nodes.map(String));
    return;
  }
  const nodeId = readNodeId(data);
  if (message.type === "executing" && nodeId) {
    progress.executing(nodeId);
    return;
  }
  if (message.type === "executed" && nodeId) {
    progress.completed([nodeId]);
    return;
  }
  if (message.type === "progress" && nodeId && finiteNumber(data.value) !== undefined && finiteNumber(data.max) !== undefined) {
    progress.nodeProgress(nodeId, finiteNumber(data.value) as number, finiteNumber(data.max) as number);
  }
}

function readNodeId(data: Record<string, unknown>): string | undefined {
  const value = data.node ?? data.node_id ?? data.display_node;
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function comfyWebSocketUrl(baseUrl: string, clientId: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/ws`;
  url.search = "";
  url.searchParams.set("clientId", clientId);
  return url.toString();
}

function defaultSocketFactory(url: string): ComfyWebSocket | undefined {
  if (typeof WebSocket === "undefined") return undefined;
  return new WebSocket(url) as unknown as ComfyWebSocket;
}

/** 仅在渠道配置了超时时组合请求截止信号。 */
function requestSignal(signal: AbortSignal, timeoutMs?: number): AbortSignal {
  return timeoutMs === undefined
    ? signal
    : AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, timeoutMs))]);
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("任务已取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, milliseconds));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("任务已取消"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
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
