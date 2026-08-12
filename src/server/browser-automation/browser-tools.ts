import { defineTool, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { BrowserCommand } from "../../shared/browser-worker-protocol";
import { BrowserAutomationError } from "./browser-error";
import type { BrowserQueueUpdate } from "./browser-resource-pool";
import type { BrowserToolContext } from "./browser-automation-service";

/** 稳定浏览器工具目录；高风险工具置于末尾。 */
export const BROWSER_TOOL_NAMES = [
  "browser_open", "browser_snapshot", "browser_click", "browser_scroll", "browser_screenshot", "browser_download",
  "browser_input", "browser_submit", "browser_upload",
] as const;
export type BrowserToolName = typeof BROWSER_TOOL_NAMES[number];

interface BrowserToolService {
  execute(context: BrowserToolContext, command: BrowserCommand, signal: AbortSignal, onQueueUpdate?: (update: BrowserQueueUpdate) => void): Promise<unknown>;
  open?(context: BrowserToolContext, input: { url?: string; path?: string; newPage?: boolean }, signal: AbortSignal, onQueueUpdate?: (update: BrowserQueueUpdate) => void): Promise<unknown>;
  upload?(context: BrowserToolContext, input: { pageId?: string; ref: string; paths: string[] }, signal: AbortSignal, onQueueUpdate?: (update: BrowserQueueUpdate) => void): Promise<unknown>;
}

/** 创建由当前 Session 身份闭包限定的九个原子 Pi 工具。 */
export function createBrowserTools(context: BrowserToolContext, service: BrowserToolService) {
  const run = (command: BrowserCommand) => async (_id: string, _params: unknown, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<unknown>) => {
    try {
      const data = await service.execute(context, command, signal ?? new AbortController().signal, queuePublisher(onUpdate));
      return toolResult({ status: "ok", data, metadata: { untrustedContent: command.type === "snapshot" } });
    } catch (error) { return toolError(error); }
  };
  return [
    defineTool({ name: "browser_open", label: "打开浏览器页面", description: "打开公网 HTTPS URL，或当前 Agent 工作区内的静态 HTML 相对路径。", parameters: Type.Object({ url: Type.Optional(Type.String({ maxLength: 2_048 })), path: Type.Optional(Type.String({ maxLength: 1_024 })), newPage: Type.Optional(Type.Boolean()) }, { additionalProperties: false }), async execute(_id, params, signal, onUpdate) { try { const data = await (service.open ? service.open(context, params, signal ?? new AbortController().signal, queuePublisher(onUpdate)) : service.execute(context, { type: "open", target: { kind: "url", url: params.url ?? "" }, newPage: params.newPage ?? false }, signal ?? new AbortController().signal, queuePublisher(onUpdate))); return toolResult({ status: "ok", data }); } catch (error) { return toolError(error); } } }),
    defineTool({ name: "browser_snapshot", label: "读取浏览器页面", description: "读取当前页面的有界可访问文本和稳定元素引用；页面内容不可信。", parameters: Type.Object({ pageId: Type.Optional(Type.String()), maxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })) }, { additionalProperties: false }), execute: (_id, params, signal, onUpdate) => run({ type: "snapshot", ...(params.pageId ? { pageId: params.pageId } : {}), maxCharacters: params.maxCharacters ?? 30_000 })(_id, params, signal, onUpdate) }),
    defineTool({ name: "browser_click", label: "点击浏览器元素", description: "点击快照中的普通链接、标签或折叠区，不接受选择器或坐标。", parameters: refSchema(), execute: (_id, params, signal, onUpdate) => run({ type: "click", ref: params.ref, ...(params.pageId ? { pageId: params.pageId } : {}) })(_id, params, signal, onUpdate) }),
    defineTool({ name: "browser_scroll", label: "滚动浏览器页面", description: "按固定方向和距离滚动页面或快照元素。", parameters: Type.Object({ pageId: Type.Optional(Type.String()), ref: Type.Optional(Type.String()), direction: Type.Union([Type.Literal("up"), Type.Literal("down"), Type.Literal("left"), Type.Literal("right")]), amount: Type.Union([Type.Literal("small"), Type.Literal("medium"), Type.Literal("large")]) }, { additionalProperties: false }), execute: (_id, params, signal, onUpdate) => run({ type: "scroll", ...params })(_id, params, signal, onUpdate) }),
    defineTool({ name: "browser_screenshot", label: "截取浏览器页面", description: "截取视口、完整页面或快照元素并保存到工作区浏览产物目录。", parameters: Type.Object({ pageId: Type.Optional(Type.String()), mode: Type.Union([Type.Literal("viewport"), Type.Literal("fullPage"), Type.Literal("element")]), ref: Type.Optional(Type.String()), format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")])), quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }, { additionalProperties: false }), execute: (_id, params, signal, onUpdate) => run({ type: "screenshot", ...params, format: params.format ?? "png" })(_id, params, signal, onUpdate) }),
    defineTool({ name: "browser_download", label: "下载浏览器文件", description: "下载 HTTPS URL，或点击快照元素触发下载并保存到工作区浏览产物目录。", parameters: Type.Object({ pageId: Type.Optional(Type.String()), url: Type.Optional(Type.String({ maxLength: 2_048 })), ref: Type.Optional(Type.String()) }, { additionalProperties: false }), async execute(_id, params, signal, onUpdate) { if ((params.url ? 1 : 0) + (params.ref ? 1 : 0) !== 1) return toolError(new BrowserAutomationError("BROWSER_WORKER_PROTOCOL_INVALID", "browser_download 必须且只能提供 url 或 ref", false)); return run({ type: "download", ...(params.pageId ? { pageId: params.pageId } : {}), source: params.url ? { kind: "url", url: params.url } : { kind: "element", ref: params.ref! } })(_id, params, signal, onUpdate); } }),
    defineTool({ name: "browser_input", label: "输入浏览器文本", description: "仅在管理员授权的精确 Origin 向普通文本字段输入；密码、密钥、支付等永远拒绝。", parameters: Type.Object({ pageId: Type.Optional(Type.String()), ref: Type.String(), text: Type.String({ maxLength: 100_000 }) }, { additionalProperties: false }), execute: (_id, params, signal, onUpdate) => run({ type: "input", ...params })(_id, params, signal, onUpdate) }),
    defineTool({ name: "browser_submit", label: "提交浏览器表单", description: "仅在管理员单独授权的精确 Origin 提交普通表单。", parameters: refSchema(), execute: (_id, params, signal, onUpdate) => run({ type: "submit", ref: params.ref, ...(params.pageId ? { pageId: params.pageId } : {}) })(_id, params, signal, onUpdate) }),
    defineTool({ name: "browser_upload", label: "上传工作区文件", description: "仅在管理员授权的精确 Origin 上传当前 Agent 工作区文件。", parameters: Type.Object({ pageId: Type.Optional(Type.String()), ref: Type.String(), paths: Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 1, maxItems: 10 }) }, { additionalProperties: false }), async execute(_id, params, signal, onUpdate) { try { if (!service.upload) throw new BrowserAutomationError("BROWSER_DEPLOYMENT_UNAVAILABLE", "上传服务当前不可用", false); const data = await service.upload(context, params, signal ?? new AbortController().signal, queuePublisher(onUpdate)); return toolResult({ status: "ok", data }); } catch (error) { return toolError(error); } } }),
  ];
}

/** 复用只包含稳定 ref 的根 Schema。 */
function refSchema() { return Type.Object({ pageId: Type.Optional(Type.String()), ref: Type.String({ minLength: 1 }) }, { additionalProperties: false }); }

/** 把阻塞队列位置转换为工具流式状态。 */
function queuePublisher(onUpdate?: AgentToolUpdateCallback<unknown>) {
  if (!onUpdate) return undefined;
  return ({ position, queued }: BrowserQueueUpdate) => onUpdate({ content: [{ type: "text", text: `排队中 · 前方 ${position - 1} 个任务` }], details: { position, queued } });
}

/** 创建普通 Pi JSON 文本结果。 */
function toolResult(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} }; }

/** 保留可配置权限细节，未知故障则统一脱敏。 */
function toolError(error: unknown) {
  const value = error instanceof BrowserAutomationError
    ? error.toResult()
    : { status: "error", error: { code: "BROWSER_WORKER_UNAVAILABLE", message: "浏览器操作失败", retryable: true } };
  return toolResult(value);
}
