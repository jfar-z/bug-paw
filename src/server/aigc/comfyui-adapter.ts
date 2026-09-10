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
  ComfyUiNodeMetadata,
  ComfyUiWidgetInputMetadata,
} from "../../shared/aigc-contracts";
import { resolveWorkflowFieldMetadata } from "../../shared/aigc-workflow-field-metadata";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";
import { validateMetadataValue } from "./aigc-workflow-service";
import { isComfyUiPrimitiveValueField, resolveComfyUiMappedField } from "./comfyui-mapped-field";

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
    const prompt = await this.buildPrompt(workflow, input);
    const clientId = randomUUID();
    const tracker = this.openStatusSocket(input.channel.baseUrl, clientId, progress);
    let promptId: string | undefined;
    try {
      progress.phase("submitting");
      const submitResponse = await this.request(`${input.channel.baseUrl}/prompt`, {
        method: "POST",
        signal: requestSignal(input.signal, input.channel.timeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, client_id: clientId }),
      });
      const submitted = await readJson(submitResponse);
      promptId = readPromptId(submitted);
      tracker?.setPromptId(promptId);
      progress.queue(0);
      const outputs = await this.pollHistory(input, promptId, progress);
      progress.phase("downloading");
      const assets = await this.collectOutputs(input, workflow.outputMappings, outputs);
      if (assets.length === 0) throw new Error("ComfyUI 工作流执行完成但没有可用产物");
      return { assets };
    } catch (error) {
      if (input.signal.aborted) {
        input.onCancellation?.(promptId ? await this.cancelQueuedPrompt(input.channel.baseUrl, promptId) : "unknown");
      }
      throw error;
    } finally {
      tracker?.close();
    }
  }

  /** 只删除精确排队任务；正在运行或状态不明确时不调用全局 interrupt。 */
  private async cancelQueuedPrompt(baseUrl: string, promptId: string): Promise<"confirmed" | "unknown"> {
    try {
      const signal = AbortSignal.timeout(5_000);
      const queue = await readJson(await this.request(`${baseUrl}/queue`, { signal }));
      const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
      if (!pending.some((entry) => Array.isArray(entry) && String(entry[1]) === promptId)) return "unknown";
      const deletion = await this.request(`${baseUrl}/queue`, {
        method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      });
      // ComfyUI 的队列修改接口允许成功时返回空响应体。
      if (!deletion.ok) return "unknown";
      await deletion.body?.cancel();
      const after = await readJson(await this.request(`${baseUrl}/queue`, { signal }));
      if (!Array.isArray(after.queue_pending) || !Array.isArray(after.queue_running)) return "unknown";
      const present = [...after.queue_pending, ...after.queue_running]
        .some((entry) => Array.isArray(entry) && String(entry[1]) === promptId);
      // 任务可能在删除前已开始并完成，存在 history 时不能声称已停止。
      const history = await readJson(await this.request(`${baseUrl}/history/${encodeURIComponent(promptId)}`, { signal }));
      return present || history[promptId] ? "unknown" : "confirmed";
    } catch {
      return "unknown";
    }
  }

  /** 根据映射生成可执行的 API 格式工作流。 */
  private async buildPrompt(
    workflow: AigcWorkflowDetail & { raw: unknown },
    input: AigcExecutionInput,
  ): Promise<Record<string, unknown>> {
    const uiWorkflow = isUiWorkflow(workflow.raw) ? workflow.raw : undefined;
    const activatedNodeIds = new Set(workflow.inputMappings.flatMap((mapping) => hasInputValue(input.inputs[mapping.name])
      ? mapping.activation?.nodeIds ?? []
      : []));
    const conversion: ApiWorkflowConversion = uiWorkflow
      ? convertUiToApi(uiWorkflow, workflow.nodeMetadata, activatedNodeIds)
      : { workflow: toApiWorkflow(workflow.raw), subgraphInputs: new Map<string, Map<string, SubgraphInputBinding>>() };
    const apiWorkflow = conversion.workflow;
    const resolvedFieldMetadata = resolveWorkflowFieldMetadata(workflow);
    const removedNodeIds = new Set<string>();
    for (const mapping of workflow.inputMappings) {
      const value = input.inputs[mapping.name];
      if (value === undefined || value === null || value === "") {
        if (mapping.required) throw new TypeError(`工作流入参 ${mapping.name} 不能为空`);
        for (const nodeId of mapping.activation?.nodeIds ?? []) removedNodeIds.add(nodeId);
        continue;
      }
      if (mapping.type === "image" || mapping.type === "video" || mapping.type === "audio") {
        const uploaded = await this.uploadAsset(input, mapping, value);
        setConvertedPath(conversion, mapping.nodeId, resolveComfyUiMappedField(uiWorkflow, workflow.nodeMetadata, mapping.nodeId, mapping.field), uploaded);
        continue;
      }
      const normalized = coerceValue(mapping, value);
      const resolvedField = resolveComfyUiMappedField(uiWorkflow, workflow.nodeMetadata, mapping.nodeId, mapping.field);
      const executionValue = coerceSubgraphInputValue(conversion, mapping.nodeId, resolvedField, normalized);
      const nodeClass = workflow.nodes.find((node) => node.id === mapping.nodeId)?.type;
      const metadata = resolvedFieldMetadata[mapping.nodeId]?.[mapping.field]
        ?? (nodeClass ? workflow.nodeMetadata?.[nodeClass]?.fields[mapping.field] : undefined);
      if (metadata && "conflict" in metadata && metadata.conflict) {
        throw new TypeError(`工作流入参 ${mapping.name} 无法解析：${metadata.conflict}`);
      }
      validateMetadataValue(mapping.name, mapping.type, executionValue, metadata, mapping.enumOptions);
      if (nodeClass === "PrimitiveNode"
        && isComfyUiPrimitiveValueField(uiWorkflow, workflow.nodeMetadata, mapping.nodeId, mapping.field)) {
        setPrimitiveTargets(apiWorkflow, workflow.edges, mapping.nodeId, executionValue);
        continue;
      }
      setConvertedPath(conversion, mapping.nodeId, resolvedField, executionValue);
    }
    pruneConditionalNodes(apiWorkflow, removedNodeIds);
    return apiWorkflow;
  }

  /** 解析媒体入参来源并写入 ComfyUI 可引用的 input 文件。 */
  private async uploadAsset(input: AigcExecutionInput, mapping: AigcWorkflowInputMapping, value: unknown): Promise<string> {
    const asset = readAssetReference(value);
    if (asset.source === "comfyui_input") {
      if (!asset.filename) throw new TypeError(`工作流入参 ${mapping.name} 的文件名无效`);
      return asset.filename;
    }
    const filePath = asset.source === "public"
      ? await input.publicFiles?.resolvePath(asset.assetId)
      : await input.assets.resolveInputPath(asset.assetId);
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
        if (text) assets.push({
          name: `${mapping.name || "output"}.txt`,
          mediaType: "text/plain",
          content: Buffer.from(String(text), "utf8"),
          outputId: mapping.id,
          outputName: mapping.name,
        });
        continue;
      }
      if (mapping.mediaType === "json") {
        if (value !== undefined) assets.push({
          name: `${mapping.name || "output"}.json`,
          mediaType: "application/json",
          content: Buffer.from(JSON.stringify(value), "utf8"),
          outputId: mapping.id,
          outputName: mapping.name,
        });
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
          outputId: mapping.id,
          outputName: mapping.name,
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

interface UiInputTarget {
  nodeId: string;
  field: string;
}

interface UiOutputSource {
  nodeId: string;
  slot: number;
}

interface SubgraphInputBinding {
  type?: string;
  targets: UiInputTarget[];
}

interface ApiWorkflowConversion {
  workflow: Record<string, unknown>;
  subgraphInputs: Map<string, Map<string, SubgraphInputBinding>>;
}

interface FlattenedUiWorkflow {
  nodes: Record<string, unknown>[];
  links: unknown[][];
  defaults: Array<UiInputTarget & { value: unknown }>;
  subgraphInputs: Map<string, Map<string, SubgraphInputBinding>>;
}

interface FlattenedContainer {
  inputs: Map<number, UiInputTarget[]>;
  outputs: Map<number, UiOutputSource>;
}

interface UiNodeReference {
  nodeId?: string;
  inputNames?: string[];
  inputs?: Map<number, UiInputTarget[]>;
  outputs?: Map<number, UiOutputSource>;
}

interface NormalizedUiLink {
  id: string;
  sourceNodeId: string;
  sourceSlot: number;
  targetNodeId: string;
  targetSlot: number;
  type?: unknown;
}

/** 将 UI 导出格式转换为 API 格式，并把外部子图展开为可执行节点。 */
function convertUiToApi(
  raw: Record<string, unknown> & { nodes: unknown[]; links?: unknown[] },
  nodeMetadata?: ComfyUiNodeMetadata,
  activatedNodeIds = new Set<string>(),
): ApiWorkflowConversion {
  const flattened = flattenUiWorkflow(raw);
  const api: Record<string, unknown> = {};
  const nodeById = new Map<string, Record<string, unknown>>();
  for (const value of flattened.nodes) {
    nodeById.set(String(value.id), value);
    if (value.type === "PrimitiveNode" || isBypassedNode(value, activatedNodeIds)) continue;
    const metadata = typeof value.type === "string" ? nodeMetadata?.[value.type] : undefined;
    if (!metadata && isUiOnlyNode(value)) continue;
    const node: Record<string, unknown> = { class_type: value.type ?? "unknown", inputs: {} };
    applyUiWidgetValues(node.inputs as Record<string, unknown>, value, metadata?.widgetInputs, metadata?.fields);
    api[String(value.id)] = node;
  }
  for (const target of flattened.defaults) setPath(api, target.nodeId, `inputs.${target.field}`, target.value);
  if (flattened.links.length > 0) {
    for (const link of flattened.links) {
      const [, , , targetId, targetSlot] = link;
      const targetNode = api[String(targetId)];
      const target = nodeById.get(String(targetId));
      const targetName = uiInputName(target, Number(targetSlot));
      if (isRecord(targetNode) && isRecord(targetNode.inputs)) {
        const source = resolveUiLinkSource(link, nodeById, flattened.links, activatedNodeIds);
        if (!source) continue;
        if (source.node.type === "PrimitiveNode") {
          (targetNode.inputs as Record<string, unknown>)[targetName] = primitiveValue(source.node);
        } else if (api[source.nodeId]) {
          (targetNode.inputs as Record<string, unknown>)[targetName] = [source.nodeId, source.slot];
        }
      }
    }
  }
  return { workflow: api, subgraphInputs: flattened.subgraphInputs };
}

/** 递归展开 definitions.subgraphs，并记录实例公开端口的真实写入目标。 */
function flattenUiWorkflow(raw: Record<string, unknown> & { nodes: unknown[]; links?: unknown[] }): FlattenedUiWorkflow {
  const definitions = subgraphDefinitions(raw.definitions);
  const flattened: FlattenedUiWorkflow = { nodes: [], links: [], defaults: [], subgraphInputs: new Map() };
  flattenUiContainer(raw.nodes, raw.links, "", definitions, flattened);
  return flattened;
}

/** 展开一层 UI 图容器；子图边界使用 -10 和 -20 表示公开输入与输出。 */
function flattenUiContainer(
  nodesValue: unknown,
  linksValue: unknown,
  namespace: string,
  definitions: Map<string, Record<string, unknown>>,
  flattened: FlattenedUiWorkflow,
): FlattenedContainer {
  const references = new Map<string, UiNodeReference>();
  const nodes = Array.isArray(nodesValue) ? nodesValue.filter(isRecord) : [];
  for (const node of nodes) {
    const localId = String(node.id);
    const nodeId = namespace ? `${namespace}:${localId}` : localId;
    const definition = typeof node.type === "string" ? definitions.get(node.type) : undefined;
    if (!definition) {
      flattened.nodes.push({ ...structuredClone(node), id: nodeId });
      references.set(localId, { nodeId, inputNames: uiInputNames(node) });
      continue;
    }
    const child = flattenUiContainer(definition.nodes, definition.links, nodeId, definitions, flattened);
    references.set(localId, child);
    const publicInputs = Array.isArray(definition.inputs) ? definition.inputs : [];
    const bindings = new Map<string, SubgraphInputBinding>();
    for (let index = 0; index < publicInputs.length; index += 1) {
      const port = isRecord(publicInputs[index]) ? publicInputs[index] : undefined;
      const name = typeof port?.name === "string" ? port.name : `slot_${index}`;
      const targets = child.inputs.get(index) ?? [];
      bindings.set(name, {
        ...(typeof port?.type === "string" ? { type: port.type } : {}),
        targets,
      });
      const value = subgraphInstanceValue(node, name, index);
      if (value !== undefined) {
        for (const target of targets) flattened.defaults.push({ ...target, value });
      }
    }
    flattened.subgraphInputs.set(nodeId, bindings);
  }

  const inputs = new Map<number, UiInputTarget[]>();
  const outputs = new Map<number, UiOutputSource>();
  for (const link of normalizeUiLinks(linksValue, namespace)) {
    const source = link.sourceNodeId === "-10"
      ? undefined
      : resolveFlattenedOutput(references.get(link.sourceNodeId), link.sourceSlot);
    const targets = link.targetNodeId === "-20"
      ? undefined
      : resolveFlattenedInputs(references.get(link.targetNodeId), link.targetSlot);
    if (link.sourceNodeId === "-10" && targets) {
      const current = inputs.get(link.sourceSlot) ?? [];
      current.push(...targets);
      inputs.set(link.sourceSlot, current);
      continue;
    }
    if (link.targetNodeId === "-20" && source) {
      outputs.set(link.targetSlot, source);
      continue;
    }
    if (!source || !targets) continue;
    for (const target of targets) {
      const targetNode = flattened.nodes.find((node) => String(node.id) === target.nodeId);
      const targetSlot = uiInputSlot(targetNode, target.field);
      if (targetSlot < 0) continue;
      flattened.links.push([link.id, source.nodeId, source.slot, target.nodeId, targetSlot, link.type]);
    }
  }
  return { inputs, outputs };
}

/** 收集合法的外部子图定义，避免 UUID 节点直接进入 Prompt API。 */
function subgraphDefinitions(value: unknown): Map<string, Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.subgraphs)) return new Map();
  return new Map(value.subgraphs.flatMap((definition) => isRecord(definition) && typeof definition.id === "string"
    ? [[definition.id, definition] as const]
    : []));
}

/** 将顶层数组连线和子图对象连线统一为内部结构。 */
function normalizeUiLinks(value: unknown, namespace: string): NormalizedUiLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((link, index) => {
    if (Array.isArray(link) && link.length >= 5) {
      return [{
        id: `${namespace || "root"}:${String(link[0] ?? index)}`,
        sourceNodeId: String(link[1]),
        sourceSlot: Number(link[2]),
        targetNodeId: String(link[3]),
        targetSlot: Number(link[4]),
        type: link[5],
      }];
    }
    if (!isRecord(link)) return [];
    return [{
      id: `${namespace || "root"}:${String(link.id ?? index)}`,
      sourceNodeId: String(link.origin_id),
      sourceSlot: Number(link.origin_slot),
      targetNodeId: String(link.target_id),
      targetSlot: Number(link.target_slot),
      type: link.type,
    }];
  }).filter((link) => Number.isInteger(link.sourceSlot) && Number.isInteger(link.targetSlot));
}

function resolveFlattenedOutput(reference: UiNodeReference | undefined, slot: number): UiOutputSource | undefined {
  if (!reference) return undefined;
  return reference.nodeId ? { nodeId: reference.nodeId, slot } : reference.outputs?.get(slot);
}

function resolveFlattenedInputs(reference: UiNodeReference | undefined, slot: number): UiInputTarget[] | undefined {
  if (!reference) return undefined;
  if (!reference.nodeId) return reference.inputs?.get(slot);
  return [{ nodeId: reference.nodeId, field: reference.inputNames?.[slot] ?? `slot_${slot}` }];
}

/** 从子图实例的具名值或顺序值读取公开输入默认值。 */
function subgraphInstanceValue(node: Record<string, unknown>, name: string, index: number): unknown {
  if (isRecord(node.widgets_values_named) && node.widgets_values_named[name] !== undefined) return node.widgets_values_named[name];
  return Array.isArray(node.widgets_values) ? node.widgets_values[index] : undefined;
}

function uiInputSlot(node: Record<string, unknown> | undefined, field: string): number {
  if (!isRecord(node) || !Array.isArray(node.inputs)) return -1;
  return node.inputs.findIndex((value) => isRecord(value) && value.name === field);
}

function uiInputNames(node: Record<string, unknown>): string[] {
  if (!Array.isArray(node.inputs)) return [];
  return node.inputs.map((value, index) => isRecord(value) && typeof value.name === "string" ? value.name : `slot_${index}`);
}

interface ResolvedUiLinkSource {
  nodeId: string;
  slot: number;
  node: Record<string, unknown>;
}

/** 递归穿过 Bypass 节点，把兼容输出连接回实际执行上游。 */
function resolveUiLinkSource(
  link: unknown[],
  nodeById: Map<string, Record<string, unknown>>,
  links: unknown[][],
  activatedNodeIds: Set<string>,
  visited = new Set<string>(),
): ResolvedUiLinkSource | undefined {
  const sourceId = String(link[1]);
  const sourceSlot = Number(link[2]);
  const sourceNode = nodeById.get(sourceId);
  if (!sourceNode || !Number.isInteger(sourceSlot) || sourceSlot < 0) return undefined;
  if (!isBypassedNode(sourceNode, activatedNodeIds)) return { nodeId: sourceId, slot: sourceSlot, node: sourceNode };
  if (visited.has(sourceId)) return undefined;
  visited.add(sourceId);

  const outputs = Array.isArray(sourceNode.outputs) ? sourceNode.outputs : [];
  const inputs = Array.isArray(sourceNode.inputs) ? sourceNode.inputs : [];
  const output = isRecord(outputs[sourceSlot]) ? outputs[sourceSlot] : undefined;
  const candidates = inputs.flatMap((value, index) => {
    if (!isRecord(value)) return [];
    const inputLink = links.find((candidate) => String(candidate[3]) === sourceId && Number(candidate[4]) === index);
    if (!inputLink || !uiSlotTypesCompatible(value.type, output?.type)) return [];
    return [{ value, index, link: inputLink }];
  });
  const selected = candidates.find(({ value }) => typeof output?.name === "string" && value.name === output.name)
    ?? candidates.find(({ index }) => index === sourceSlot)
    ?? (candidates.length === 1 ? candidates[0] : undefined);
  return selected ? resolveUiLinkSource(selected.link, nodeById, links, activatedNodeIds, visited) : undefined;
}

/** ComfyUI 的复合槽位类型以逗号分隔，任一类型相交即可旁路。 */
function uiSlotTypesCompatible(inputType: unknown, outputType: unknown): boolean {
  if (typeof inputType !== "string" || typeof outputType !== "string") return false;
  const inputs = new Set(inputType.split(",").map((value) => value.trim()).filter(Boolean));
  const outputs = outputType.split(",").map((value) => value.trim()).filter(Boolean);
  return inputs.has("*") || outputs.includes("*") || outputs.some((value) => inputs.has(value));
}

/** mode 4 是 ComfyUI UI 工作流中的 Bypass 状态。 */
function isBypassedNode(node: Record<string, unknown>, activatedNodeIds: Set<string>): boolean {
  return node.mode === 4 && !activatedNodeIds.has(String(node.id));
}

/** 统一判断运行入参是否会启用条件节点组。 */
function hasInputValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

/** 无连接能力且未注册元数据的节点仅承载前端说明，不应进入 API Prompt。 */
function isUiOnlyNode(node: Record<string, unknown>): boolean {
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  return inputs.length === 0
    && outputs.length === 0
    && typeof node.type === "string"
    && /(?:markdown|note)$/iu.test(node.type);
}

/** 把 UI 节点控件值恢复为 ComfyUI API 输入字段。 */
function applyUiWidgetValues(
  inputs: Record<string, unknown>,
  node: Record<string, unknown>,
  widgetInputs?: ComfyUiWidgetInputMetadata[],
  fields?: Record<string, { valueType?: unknown }>,
): void {
  const values = node.widgets_values;
  if (isRecord(values)) {
    for (const [name, value] of Object.entries(values)) {
      // 视频预览状态等对象只供前端恢复界面，不属于 API 节点输入。
      if (isWidgetScalar(value)) inputs[name] = value;
    }
    return;
  }
  if (!Array.isArray(values)) return;
  const namedValues = node.widgets_values_named;
  if ((!widgetInputs?.length && !fields) && isRecord(namedValues)) {
    let applied = false;
    for (const [name, value] of Object.entries(namedValues)) {
      // control_after_generate 只控制前端下次随机化行为，不属于 Prompt API 输入。
      if (name === "control_after_generate" || !isWidgetScalar(value)) continue;
      inputs[name] = value;
      applied = true;
    }
    if (applied) return;
  }
  const descriptors = widgetInputs?.length
    ? widgetInputs
    : fallbackWidgetInputs(String(node.type), fields);
  if (isRecord(namedValues) && applyNamedWidgetValues(inputs, namedValues, descriptors, fields)) return;
  const names = expandWidgetInputNames(descriptors, values);
  for (let index = 0; index < Math.min(names.length, values.length); index += 1) {
    if (isWidgetScalar(values[index])) inputs[names[index]] = values[index];
  }
}

/** 优先使用具名控件值，避免随机种子控制项等前端附加值造成位置错位。 */
function applyNamedWidgetValues(
  inputs: Record<string, unknown>,
  values: Record<string, unknown>,
  descriptors: ComfyUiWidgetInputMetadata[],
  fields?: Record<string, { valueType?: unknown }>,
): boolean {
  const allowedNames = new Set(Object.keys(fields ?? {})
    .filter((field) => field.startsWith("inputs."))
    .map((field) => field.replace(/^inputs\./u, "")));
  for (const descriptor of descriptors) {
    allowedNames.add(descriptor.name);
    const selectedValue = values[descriptor.name];
    if (!descriptor.dynamicOptions || !isWidgetScalar(selectedValue)) continue;
    for (const name of descriptor.dynamicOptions[String(selectedValue)] ?? []) {
      allowedNames.add(`${descriptor.name}.${name}`);
    }
  }

  let applied = false;
  for (const name of allowedNames) {
    const value = values[name];
    if (!isWidgetScalar(value)) continue;
    inputs[name] = value;
    applied = true;
  }
  return applied;
}

/** 动态控件根据当前选项在父字段后展开对应子字段。 */
function expandWidgetInputNames(descriptors: ComfyUiWidgetInputMetadata[], values: unknown[]): string[] {
  const names: string[] = [];
  for (const descriptor of descriptors) {
    const selectedValue = values[names.length];
    names.push(descriptor.name);
    if (descriptor.dynamicOptions && isWidgetScalar(selectedValue)) {
      const nested = descriptor.dynamicOptions[String(selectedValue)] ?? [];
      names.push(...nested.map((name) => `${descriptor.name}.${name}`));
    }
  }
  return names;
}

/** 兼容尚未重新同步控件顺序的旧工作流元数据。 */
function fallbackWidgetInputs(
  nodeType: string,
  fields?: Record<string, { valueType?: unknown }>,
): ComfyUiWidgetInputMetadata[] {
  const fromMetadata = Object.entries(fields ?? {})
    .filter(([, metadata]) => metadata.valueType !== undefined)
    .map(([field]) => ({ name: field.replace(/^inputs\./u, "") }));
  return fromMetadata.length > 0
    ? fromMetadata
    : widgetInputNames(nodeType).map((name) => ({ name }));
}

function isWidgetScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** 读取 ComfyUI Primitive 的实际值，控制模式等附加 widget 不参与执行。 */
function primitiveValue(node: Record<string, unknown>): unknown {
  return Array.isArray(node.widgets_values) ? node.widgets_values[0] : undefined;
}

/** 将 Primitive 映射值写入全部下游，保持一处参数同时控制多个节点。 */
function setPrimitiveTargets(workflow: Record<string, unknown>, edges: AigcWorkflowDetail["edges"], nodeId: string, value: unknown): void {
  const targets = edges.filter((edge) => edge.sourceNodeId === nodeId);
  if (targets.length === 0) throw new TypeError(`PrimitiveNode ${nodeId} 没有可写入的下游字段`);
  for (const target of targets) setPath(workflow, target.targetNodeId, target.targetField, value);
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

/** 子图实例字段需要写入展开后的全部内部目标。 */
function setConvertedPath(conversion: ApiWorkflowConversion, nodeId: string, field: string, value: unknown): void {
  const base = field.replace(/^(inputs|widgets_values)\./, "");
  const binding = conversion.subgraphInputs.get(nodeId)?.get(base);
  if (!binding) {
    setPath(conversion.workflow, nodeId, field, value);
    return;
  }
  if (binding.targets.length === 0) throw new TypeError(`子图节点 ${nodeId} 的输入 ${base} 没有内部目标`);
  for (const target of binding.targets) setPath(conversion.workflow, target.nodeId, `inputs.${target.field}`, value);
}

/** 兼容旧映射把 INT/FLOAT/BOOLEAN 子图端口保存成字符串的情况。 */
function coerceSubgraphInputValue(
  conversion: ApiWorkflowConversion,
  nodeId: string,
  field: string,
  value: unknown,
): unknown {
  const base = field.replace(/^(inputs|widgets_values)\./, "");
  const type = conversion.subgraphInputs.get(nodeId)?.get(base)?.type?.toUpperCase();
  if (type === "INT" && typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value);
  if (type === "FLOAT" && typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (type === "BOOLEAN" && typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return value;
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
  if (mapping.type === "int" && typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) return value;
  if (mapping.type === "double" && typeof value === "number" && Number.isFinite(value)) return value;
  if (mapping.type === "string") return String(value);
  if (mapping.type === "enum" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) return value;
  return value;
}

function readAssetReference(value: unknown): {
  source: "upload" | "public" | "comfyui_input";
  assetId: string;
  filename?: string;
  name?: string;
  mediaType?: string;
} {
  if (!isRecord(value)) throw new TypeError("媒体入参格式无效");
  const source = value.source === "public" || value.source === "comfyui_input" ? value.source : "upload";
  if (source === "comfyui_input") {
    if (typeof value.filename !== "string" || !value.filename) throw new TypeError("媒体入参格式无效");
    return {
      source,
      assetId: "",
      filename: value.filename,
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    };
  }
  if (typeof value.assetId !== "string" || !value.assetId) throw new TypeError("媒体入参格式无效");
  return {
    source,
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
