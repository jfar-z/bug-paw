import type { CredentialStatus } from "./configuration-contracts";

/** 当前支持的 AIGC 渠道协议。 */
export const AIGC_CHANNEL_TYPES = ["openai", "grok", "comfyui"] as const;
export type AigcChannelType = typeof AIGC_CHANNEL_TYPES[number];

/** AIGC 渠道创建时可选用的官方模板。 */
export interface AigcChannelTemplate {
  id: string;
  name: string;
  type: AigcChannelType;
  defaultBaseUrl: string;
  credentialOptional: boolean;
}

/** 单条渠道的非敏感配置。 */
export interface AigcChannelConfig {
  /** 创建后不可修改的渠道标识。 */
  id: string;
  /** 配置中心展示的渠道名称。 */
  name: string;
  /** 渠道协议类型。 */
  type: AigcChannelType;
  /** 去除尾部斜杠后的服务基础地址。 */
  baseUrl: string;
  /** 是否允许接口引用该渠道。 */
  enabled: boolean;
  /** 上游请求超时毫秒数。 */
  timeoutMs: number;
}

/** 返回浏览器的渠道摘要，不包含凭证明文。 */
export interface AigcChannelSummary extends AigcChannelConfig {
  /** 当前渠道是否已保存 API Key。 */
  hasApiKey: boolean;
}

/** 浏览器提交的渠道配置字段。 */
export interface AigcChannelInput {
  name: string;
  type: AigcChannelType;
  baseUrl: string;
  enabled: boolean;
  timeoutMs: number;
}

/** 对渠道凭证执行的明确操作。 */
export type AigcCredentialMutation =
  | { action: "keep" }
  | { action: "replace"; apiKey: string }
  | { action: "remove" };

/** 原子创建渠道与可选凭证的输入。 */
export interface AigcCreateChannelInput {
  configRevision: string;
  credentialRevision: string;
  channel: AigcChannelConfig;
  apiKey?: string;
}

/** 原子编辑渠道及其凭证的输入。 */
export interface AigcUpdateChannelInput {
  configRevision: string;
  credentialRevision: string;
  channel: AigcChannelConfig;
  credential: AigcCredentialMutation;
}

/** 配置中心读取的 AIGC 渠道设置文档。 */
export interface AigcSettingsDocument {
  revision: string;
  channels: AigcChannelSummary[];
  channelTemplates: AigcChannelTemplate[];
  credentials: CredentialStatus[];
  credentialRevision: string;
}

/** 工作流入参可选的参数类型。 */
export type AigcWorkflowInputType = "bool" | "int" | "double" | "string" | "enum" | "image" | "video";

/** ComfyUI 工作流中的单个输入字段映射。 */
export interface AigcWorkflowInputMapping {
  id: string;
  /** 展示给调用方的稳定参数名。 */
  name: string;
  nodeId: string;
  /** 目标节点的输入字段路径，例如 inputs.text。 */
  field: string;
  type: AigcWorkflowInputType;
  required: boolean;
  /** enum 类型可选的候选值。 */
  enumOptions?: string[];
  defaultValue?: string | number | boolean;
  description?: string;
}

/** ComfyUI 工作流输出字段映射。 */
export interface AigcWorkflowOutputMapping {
  id: string;
  name: string;
  nodeId: string;
  /** 从该节点读取输出时使用的字段路径。 */
  field: string;
  mediaType: "image" | "video" | "json" | "text";
  description?: string;
}

/** 解析后的 ComfyUI 节点。 */
export interface ComfyUiNode {
  id: string;
  type: string;
  title?: string;
  /** 可用于字段映射的节点字段列表。 */
  fields: ComfyUiField[];
}

/** 解析后的 ComfyUI 节点字段。 */
export interface ComfyUiField {
  name: string;
  kind: "input" | "output" | "widget" | "unknown";
  /** 基于 ComfyUI 节点字段内容推断出的值类型。 */
  valueType?: AigcWorkflowInputType;
}

/** 解析后的 ComfyUI 节点连线。 */
export interface ComfyUiEdge {
  id: string;
  sourceNodeId: string;
  sourceField: string;
  targetNodeId: string;
  targetField: string;
}

/** 工作流列表项。 */
export interface AigcWorkflowSummary {
  id: string;
  name: string;
  fileName: string;
  originalHash: string;
  nodeCount: number;
  edgeCount: number;
  inputCount: number;
  outputCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 工作流详情。 */
export interface AigcWorkflowDetail {
  id: string;
  name: string;
  fileName: string;
  originalHash: string;
  nodes: ComfyUiNode[];
  edges: ComfyUiEdge[];
  inputMappings: AigcWorkflowInputMapping[];
  outputMappings: AigcWorkflowOutputMapping[];
  createdAt: string;
  updatedAt: string;
}

/** 工作流列表文档。 */
export interface AigcWorkflowDocument {
  revision: string;
  workflows: AigcWorkflowSummary[];
}

/** 导入工作流时的浏览器输入。 */
export interface AigcWorkflowCreateInput {
  name: string;
  fileName: string;
  /** 完整的 ComfyUI 工作流 JSON，由服务端解析但不会执行脚本。 */
  workflowJson: unknown;
  inputMappings: AigcWorkflowInputMapping[];
  outputMappings: AigcWorkflowOutputMapping[];
}

/** 更新工作流映射时的浏览器输入。 */
export interface AigcWorkflowUpdateInput {
  name: string;
  inputMappings: AigcWorkflowInputMapping[];
  outputMappings: AigcWorkflowOutputMapping[];
}

/** 工作流详情文档。 */
export interface AigcWorkflowDetailDocument {
  revision: string;
  workflow: AigcWorkflowDetail;
}

/** 接口使用的协议类型。 */
export type AigcInterfaceProtocol = AigcChannelType;

/** 接口可暴露给用户的能力类型。 */
export type AigcInterfaceCapability = "text-to-image" | "image-edit" | "text-to-video" | "image-to-video";

/** OpenAI 协议接口参数。 */
export interface AigcOpenAiInterfaceConfig {
  model: string;
  size?: string;
  quality?: string;
  responseFormat?: string;
}

/** Grok 协议接口参数。 */
export interface AigcGrokInterfaceConfig {
  model: string;
}

/** ComfyUI 协议接口参数。 */
export interface AigcComfyUiInterfaceConfig {
  workflowId: string;
}

/** 单个 AIGC 接口的非敏感配置。 */
export interface AigcInterfaceRecord {
  id: string;
  name: string;
  description: string;
  protocol: AigcInterfaceProtocol;
  capability: AigcInterfaceCapability;
  channelId: string;
  enabled: boolean;
  /** 预留未来发布为 Agent 工具，本期不提供实际工具注册。 */
  toolPublishEnabled: boolean;
  config: AigcOpenAiInterfaceConfig | AigcGrokInterfaceConfig | AigcComfyUiInterfaceConfig;
  createdAt: string;
  updatedAt: string;
}

/** 接口列表文档。 */
export interface AigcInterfaceDocument {
  revision: string;
  interfaces: AigcInterfaceRecord[];
}

/** 接口创建或更新的浏览器输入。 */
export interface AigcInterfaceInput {
  name: string;
  description: string;
  protocol: AigcInterfaceProtocol;
  capability: AigcInterfaceCapability;
  channelId: string;
  enabled: boolean;
  toolPublishEnabled: boolean;
  config: AigcOpenAiInterfaceConfig | AigcGrokInterfaceConfig | AigcComfyUiInterfaceConfig;
}

/** AIGC 任务状态。 */
export type AigcTaskStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 任务产物引用。 */
export interface AigcTaskAsset {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  createdAt: string;
}

/** 任务失败时返回的脱敏错误。 */
export interface AigcTaskError {
  code: string;
  message: string;
}

/** 任务详情。 */
export interface AigcTaskRecord {
  id: string;
  interfaceId: string;
  interfaceName: string;
  channelId: string;
  status: AigcTaskStatus;
  inputs: Record<string, unknown>;
  assets: AigcTaskAsset[];
  error?: AigcTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 任务列表项。 */
export interface AigcTaskSummary {
  id: string;
  interfaceId: string;
  interfaceName: string;
  channelId: string;
  status: AigcTaskStatus;
  assetCount: number;
  error?: AigcTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 任务列表文档。 */
export interface AigcTaskDocument {
  tasks: AigcTaskSummary[];
}

/** 手动试运行提交的入参。 */
export type AigcRunInputValue = boolean | number | string | { assetId: string; name: string; mediaType: string };

/** 手动试运行请求。 */
export interface AigcRunRequest {
  interfaceId: string;
  inputs: Record<string, AigcRunInputValue>;
}

/** 上传到 AIGC 工作台的临时输入资产。 */
export interface AigcUploadedAsset {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}
