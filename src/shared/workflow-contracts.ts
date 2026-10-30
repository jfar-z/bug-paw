/** 跨服务传递的工作流参数类型；数组通过 multiple 声明，不混入枚举。 */
export type WorkflowValueType =
  | "string"
  | "float"
  | "integer"
  | "boolean"
  | "object"
  | "image"
  | "video"
  | "audio"
  | "file";
/** 可序列化、可检查的工作流参数定义。 */
export interface WorkflowField {
  name: string;
  type: WorkflowValueType;
  multiple?: boolean;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
  /** 通用参数的枚举是字符串约束，外部接口可保留原始标量选项。 */
  enumValues?: (string | number | boolean)[];
  /** 仅引用类型定义，不作为运行时数据依赖。 */
  enumSource?: { nodeId: string; field: string; interfaceId: string };
}
/** 外部能力输入由接口固定类型，并保留枚举、数值及数量约束。 */
export interface WorkflowInputField extends WorkflowField {
  min?: number;
  max?: number;
  maxItems?: number;
}
/** 脚本辅助仅接收当前节点上下文，不携带其他节点脚本或运行数据。 */
export interface WorkflowScriptAssistRequest {
  provider: string;
  modelId: string;
  requirement: string;
  script: string;
  inputs: {
    name: string;
    type?: WorkflowValueType;
    multiple?: boolean;
    description?: string;
    source: WorkflowBinding;
  }[];
  outputs: WorkflowField[];
  timeoutMs: number;
}
/** 媒体只传递受控资产引用，不能携带宿主路径。 */
export interface WorkflowFile {
  assetId: string;
  name: string;
  mediaType: string;
  size: number;
}
/** 输入来源为常量或上游节点的命名输出。 */
export type WorkflowBinding =
  | { kind: "literal"; value: unknown }
  | { kind: "reference"; nodeId: string; field: string };
/** 第一版支持的节点集合。 */
export type WorkflowNodeKind =
  | "input"
  | "output"
  | "llm"
  | "agent"
  | "aigc"
  | "condition"
  | "select"
  | "javascript";
/** 条件使用有限运算符，不对用户字符串执行代码。 */
export interface WorkflowCondition {
  left: WorkflowBinding;
  operator:
    | "eq"
    | "ne"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "empty"
    | "not_empty";
  right: WorkflowBinding;
}
/** 节点的专属设置，未使用的设置不参与当前节点执行。 */
export interface WorkflowNodeConfig {
  provider?: string;
  modelId?: string;
  systemPrompt?: string;
  thinking?:
    | "inherit"
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  customParameters?: Record<string, unknown>;
  agentId?: string;
  sessionMode?: "new" | "fixed";
  sessionId?: string;
  archiveAfterCompletion?: boolean;
  interfaceId?: string;
  /** 未配置的参考组沿用拆分输入；数组模式单独保存上游绑定。 */
  referenceGroups?: Record<
    string,
    { mode: "array"; binding?: WorkflowBinding }
  >;
  conditions?: WorkflowCondition[];
  conditionMode?: "all" | "any";
  candidates?: WorkflowBinding[];
  selectMode?: "first_available" | "condition";
  selectCondition?: WorkflowCondition;
  script?: string;
  timeoutMs?: number;
}
/** 节点输入映射与输出类型是运行时校验的依据。 */
export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  name: string;
  position: { x: number; y: number };
  inputs: Record<string, WorkflowBinding>;
  outputs: WorkflowField[];
  config: WorkflowNodeConfig;
}
/** 控制边决定执行可达性；判断节点的边带有 true/false 分支。 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  branch?: "true" | "false";
}
/** 管理员保存的工作流定义；revision 用于乐观并发保护。 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  revision: number;
  published: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}
export type WorkflowDraft = Pick<
  WorkflowDefinition,
  "name" | "description" | "published" | "nodes" | "edges"
>;
export type WorkflowStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";
/** 节点错误保留安全消息、稳定代码和运行追踪标识。 */
export interface WorkflowError {
  code: string;
  message: string;
  requestId: string;
  nodeId?: string;
}
export interface WorkflowNodeRun {
  nodeId: string;
  status: WorkflowStatus;
  inputs?: Record<string, unknown>;
  referenceGroups?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  error?: WorkflowError;
  progress?: string;
  events: { at: string; message: string }[];
}
/** 一次运行持有不可变定义快照，避免编辑影响正在执行的任务。 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodes: WorkflowNodeRun[];
  createdAt: string;
  finishedAt?: string;
  error?: WorkflowError;
  origin?: { agentId: string; sessionId: string };
  requestKey: string;
  requestHash: string;
}
/** 参考组只公开类型与有序参数名，不暴露 ComfyUI 内部节点。 */
export interface WorkflowReferenceGroup {
  id: string;
  label: string;
  type: "image" | "video" | "audio";
  fields: string[];
}
/** 编辑器目录仅包含安全配置摘要。 */
export interface WorkflowCatalog {
  models: {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    images: boolean;
  }[];
  agents: { id: string; name: string }[];
  interfaces: {
    id: string;
    name: string;
    fields: WorkflowInputField[];
    referenceGroups?: WorkflowReferenceGroup[];
    outputs: WorkflowField[];
  }[];
}
export const WORKFLOW_TYPES: WorkflowValueType[] = [
  "string",
  "float",
  "integer",
  "boolean",
  "object",
  "image",
  "video",
  "audio",
  "file",
];
export const WORKFLOW_NODE_NAMES: Record<WorkflowNodeKind, string> = {
  input: "输入",
  output: "输出",
  llm: "大模型",
  agent: "Agent",
  aigc: "AIGC",
  condition: "判断",
  select: "选择",
  javascript: "JS 脚本",
};

/** 新建节点时给出可编辑默认值，不伪造模型、Agent 或接口标识。 */
export function newWorkflowNode(
  kind: WorkflowNodeKind,
  id: string,
  position = { x: 300, y: 160 },
): WorkflowNode {
  const node: WorkflowNode = {
    id,
    kind,
    name: WORKFLOW_NODE_NAMES[kind],
    position,
    inputs: {},
    outputs: [],
    config: {},
  };
  if (kind === "input")
    node.outputs = [
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "本次任务需求",
      },
    ];
  if (kind === "output")
    node.outputs = [{ name: "result", type: "string", required: true }];
  if (kind === "llm") {
    node.config = {
      thinking: "inherit",
      temperature: 0.7,
      topP: 1,
      maxTokens: 4096,
      frequencyPenalty: 0,
      presencePenalty: 0,
      customParameters: {},
      systemPrompt: "",
    };
    node.outputs = [{ name: "text", type: "string", required: true }];
  }
  if (kind === "agent") {
    node.config = { sessionMode: "new", archiveAfterCompletion: false };
    node.outputs = [
      { name: "text", type: "string" },
      { name: "files", type: "file", multiple: true },
      { name: "sessionId", type: "string" },
    ];
  }
  if (kind === "aigc")
    node.outputs = [{ name: "files", type: "file", multiple: true }];
  if (kind === "condition") {
    node.config = {
      conditionMode: "all",
      conditions: [
        {
          left: { kind: "literal", value: true },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
      ],
    };
    node.outputs = [{ name: "result", type: "boolean", required: true }];
  }
  if (kind === "select") {
    node.config = { selectMode: "first_available", candidates: [] };
    node.outputs = [{ name: "result", type: "string" }];
  }
  if (kind === "javascript") {
    node.config = {
      script:
        '// inputs 包含本节点映射的输入；返回值应与输出定义一致。\nreturn { result: String(inputs.value ?? "") };',
      timeoutMs: 1000,
    };
    node.inputs = { value: { kind: "literal", value: "" } };
    node.outputs = [{ name: "result", type: "string", required: true }];
  }
  return node;
}

/** 默认流程可直接运行，以输入到输出验证完整链路。 */
export function emptyWorkflow(): WorkflowDraft {
  const input = newWorkflowNode("input", "input", { x: 80, y: 140 });
  const output = newWorkflowNode("output", "output", { x: 440, y: 140 });
  output.inputs.result = {
    kind: "reference",
    nodeId: "input",
    field: "prompt",
  };
  return {
    name: "新工作流",
    description: "",
    published: false,
    nodes: [input, output],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}
