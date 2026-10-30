import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { setTimeout as delay } from "node:timers/promises";
import type {
  WorkflowField,
  WorkflowRun,
} from "../../shared/workflow-contracts";
import { DomainError, toSafePublicMessage } from "../core/errors";
import type { WorkflowService } from "./workflow-service";
import type { WorkflowFiles } from "./workflow-files";
import { invalid, record } from "./workflow-validation";

export interface WorkflowToolContext {
  agentId: string;
  sessionId: string;
}
/** 会话工具共享业务授权、文件边界与幂等语义。 */
export class WorkflowToolService {
  private readonly deliveries = new Map<string, Promise<unknown>>();
  constructor(
    readonly workflows: WorkflowService,
    private readonly files: WorkflowFiles,
    private readonly allowed: (agentId: string) => Promise<string[]>,
  ) {}
  async authorize(context: WorkflowToolContext, tool: string): Promise<void> {
    if (!(await this.allowed(context.agentId)).includes(tool))
      throw new DomainError("FORBIDDEN", `当前 Agent 未获 ${tool} 权限`);
  }
  async published(id: string) {
    const item = await this.workflows.get(id);
    if (!item.published)
      throw new DomainError("FORBIDDEN", "工作流未发布或已撤销发布");
    return item;
  }
  async list(
    context: WorkflowToolContext,
    input: { action: string; workflowId: string | null; offset: number | null },
  ) {
    await this.authorize(context, "workflow_list");
    if (input.action === "get") {
      if (!input.workflowId || input.offset !== null)
        invalid("get 要求 workflowId 为真实 ID 且 offset=null");
      const item = await this.published(input.workflowId);
      return {
        id: item.id,
        name: item.name,
        description: item.description,
        revision: item.revision,
        inputs: item.nodes.find((n) => n.kind === "input")!.outputs,
        outputs: item.nodes.find((n) => n.kind === "output")!.outputs,
      };
    }
    if (
      input.action !== "list" ||
      input.workflowId !== null ||
      !Number.isInteger(input.offset) ||
      input.offset! < 0
    )
      invalid("list 要求 workflowId=null 和非负整数 offset");
    const items = (await this.workflows.list()).filter((w) => w.published);
    const offset = input.offset!;
    return {
      workflows: items.slice(offset, offset + 20).map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        revision: w.revision,
      })),
      total: items.length,
      nextOffset: offset + 20 < items.length ? offset + 20 : null,
    };
  }
  /** 仅公开调用所需的参数契约，不返回内部节点、绑定和枚举来源。 */
  async parameters(context: WorkflowToolContext, id: string) {
    await this.authorize(context, "workflow_get_parameters");
    if (typeof id !== "string" || !id.trim() || id.length > 120)
      invalid("workflowId 必须为非空工作流 ID，最多 120 个字符");
    const item = await this.published(id);
    // 明确列出公开字段，防止以后扩展节点元数据时意外增加工具上下文。
    const fields = (values: WorkflowField[]) =>
      values.map((field) => ({
        name: field.name,
        type: field.type,
        multiple: field.multiple,
        required: field.required,
        description: field.description,
        defaultValue: field.defaultValue,
        enumValues: field.enumValues,
      }));
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      revision: item.revision,
      inputs: fields(item.nodes.find((node) => node.kind === "input")!.outputs),
      outputs: fields(
        item.nodes.find((node) => node.kind === "output")!.outputs,
      ),
    };
  }
  async definition(context: WorkflowToolContext, id: string) {
    await this.authorize(context, "workflow_get_definition");
    return this.published(id);
  }
  async start(
    context: WorkflowToolContext,
    tool: string,
    input: {
      workflowId: string;
      requestKey: string;
      parameters: { name: string; value: unknown }[];
    },
  ) {
    await this.authorize(context, tool);
    const definition = await this.published(input.workflowId);
    const fields = definition.nodes.find((n) => n.kind === "input")!.outputs;
    const values: Record<string, unknown> = {};
    for (const entry of input.parameters) {
      const field = fields.find((f) => f.name === entry.name);
      if (!field || Object.hasOwn(values, entry.name))
        invalid("工作流参数名称不存在或重复");
      values[entry.name] = await this.inputValue(context, field, entry.value);
    }
    return this.workflows.start(
      input.workflowId,
      values,
      input.requestKey,
      context,
      Object.fromEntries(input.parameters.map((p) => [p.name, p.value])),
    );
  }
  private async inputValue(
    context: WorkflowToolContext,
    field: WorkflowField,
    value: unknown,
  ): Promise<unknown> {
    if (value === null && !field.required) return null;
    if (field.multiple) {
      if (!Array.isArray(value)) invalid(`参数 ${field.name} 需要数组`);
      return Promise.all(
        value.map((v) =>
          this.inputValue(
            context,
            { ...field, multiple: false, required: true },
            v,
          ),
        ),
      );
    }
    if (["image", "video", "audio", "file"].includes(field.type)) {
      if (typeof value !== "string")
        invalid(`媒体参数 ${field.name} 必须为当前 Agent 的工作区相对路径`);
      return this.files.importPath(context.agentId, value);
    }
    return value;
  }
  async get(
    context: WorkflowToolContext,
    id: string,
    tool = "workflow_get_task",
  ) {
    await this.authorize(context, tool);
    const run = this.workflows.getRun(id, context);
    await this.published(run.workflowId);
    const outputs =
      run.status === "succeeded"
        ? await this.deliverValue(context, run.outputs)
        : {};
    return {
      taskId: run.id,
      workflowId: run.workflowId,
      status: run.status,
      outputs,
      error: run.error,
      nodes: run.nodes.map((n) => ({
        nodeId: n.nodeId,
        status: n.status,
        progress: n.progress,
        error: n.error,
      })),
      pollAfterMs: 2000,
    };
  }
  /** 只向任务所属 Agent 交付产物；连续查询复用本进程已有交付。 */
  private async deliverValue(
    context: WorkflowToolContext,
    value: unknown,
  ): Promise<unknown> {
    if (Array.isArray(value))
      return Promise.all(value.map((v) => this.deliverValue(context, v)));
    if (record(value)) {
      if (typeof value.assetId === "string") {
        const key = context.agentId + ":" + value.assetId;
        let delivery = this.deliveries.get(key);
        if (!delivery) {
          delivery = this.files.toWorkspace(
            value,
            context.agentId,
            context.agentId,
          );
          this.deliveries.set(key, delivery);
          void delivery.catch(() => this.deliveries.delete(key));
        }
        return delivery;
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value).map(async ([k, v]) => [
            k,
            await this.deliverValue(context, v),
          ]),
        ),
      );
    }
    return value;
  }
  async cancel(context: WorkflowToolContext, id: string) {
    await this.authorize(context, "workflow_cancel_task");
    const run = await this.workflows.cancel(id, context);
    return {
      taskId: run.id,
      status: run.status,
      nodes: run.nodes.map((n) => ({
        nodeId: n.nodeId,
        status: n.status,
        events: n.events,
      })),
    };
  }
  async wait(
    context: WorkflowToolContext,
    id: string,
    signal?: AbortSignal,
    onProgress?: (value: unknown) => void,
  ) {
    const deadline = Date.now() + 30 * 60_000;
    while (true) {
      const state = await this.get(context, id, "workflow_run_and_wait");
      onProgress?.(state);
      if (!["queued", "running"].includes(state.status))
        return { ...state, waitStatus: "completed" };
      if (signal?.aborted || Date.now() >= deadline)
        return {
          ...state,
          waitStatus: signal?.aborted ? "interrupted" : "timed_out",
        };
      try {
        await delay(2000, undefined, { signal });
      } catch (error) {
        if (!signal?.aborted) throw error;
        return { ...state, waitStatus: "interrupted" };
      }
    }
  }
}

/** 所有工具使用根对象、必填操作或参数；对象/数组值由工作流定义二次校验。 */
export function createWorkflowTools(
  context: WorkflowToolContext,
  service: WorkflowToolService,
) {
  const id = Type.String({ minLength: 1, maxLength: 120 });
  const parameters = Type.Array(
    Type.Object(
      {
        name: Type.String({ minLength: 1, maxLength: 80 }),
        value: Type.Union(
          [
            Type.String(),
            Type.Number(),
            Type.Boolean(),
            Type.Null(),
            Type.Array(Type.Unknown()),
            Type.Object({}, { additionalProperties: true }),
          ],
          {
            description:
              "按定义提供 JSON 值；媒体使用当前 Agent 工作区相对路径，多媒体使用路径数组",
          },
        ),
      },
      { additionalProperties: false },
    ),
    { maxItems: 100 },
  );
  const runParameters = Type.Object(
    {
      workflowId: id,
      requestKey: Type.String({
        minLength: 1,
        maxLength: 80,
        pattern: "^[A-Za-z0-9_-]+$",
      }),
      parameters,
    },
    { additionalProperties: false },
  );
  return [
    defineTool({
      name: "workflow_list",
      label: "查询工作流",
      description:
        "分页查询已发布工作流，或读取输入输出参数定义。list 使用 workflowId=null、offset=0；get 使用真实 workflowId、offset=null。",
      parameters: Type.Object(
        {
          action: Type.Union([Type.Literal("list"), Type.Literal("get")]),
          workflowId: Type.Union([id, Type.Null()]),
          offset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
        },
        { additionalProperties: false },
      ),
      execute: async (_id, p) => result(() => service.list(context, p)),
    }),
    defineTool({
      name: "workflow_get_parameters",
      label: "查询工作流出入参",
      description:
        "读取已发布工作流的名称、说明、版本和输入输出参数（名称、类型、数组、必填、说明、默认值、枚举选项）。不返回节点、连线、脚本或参数绑定。先用 workflow_list 取得真实工作流 ID。",
      promptSnippet:
        "调用工作流前优先用 workflow_get_parameters 查询出入参；仅需填写参数时不要读取完整定义。媒体传当前 Agent 工作区相对路径，媒体数组传路径数组。",
      parameters: Type.Object(
        { workflowId: id },
        { additionalProperties: false },
      ),
      execute: async (_id, p) =>
        result(() => service.parameters(context, p.workflowId)),
    }),
    defineTool({
      name: "workflow_get_definition",
      label: "查询工作流定义",
      description:
        "仅在需要检查内部实现时读取已发布工作流的完整节点配置、脚本、连线和参数绑定；只查询出入参请优先用 workflow_get_parameters，或 workflow_list 的 get 模式。先查询清单取得真实 ID。",
      parameters: Type.Object(
        { workflowId: id },
        { additionalProperties: false },
      ),
      execute: async (_id, p) =>
        result(() => service.definition(context, p.workflowId)),
    }),
    defineTool({
      name: "workflow_run",
      label: "调用工作流",
      description:
        "异步启动已发布工作流，可能计费。先用 workflow_get_parameters 或 workflow_list 的 get 模式查询参数，同一次调用必须复用 requestKey；不要重复提交查询状态。",
      parameters: runParameters,
      execute: async (_id, p) =>
        result(async () => {
          const r = await service.start(context, "workflow_run", p);
          return { taskId: r.id, status: r.status, pollAfterMs: 2000 };
        }),
    }),
    defineTool({
      name: "workflow_run_and_wait",
      label: "调用并等待工作流",
      description:
        "启动并等待工作流，可能计费。先用 workflow_get_parameters 或 workflow_list 的 get 模式查询参数。中止聊天只结束等待，取消任务请调用 workflow_cancel_task。",
      parameters: runParameters,
      execute: async (_id, p, signal, onUpdate) =>
        result(async () => {
          const r = await service.start(context, "workflow_run_and_wait", p);
          return service.wait(context, r.id, signal, (value) =>
            onUpdate?.({
              content: [{ type: "text", text: JSON.stringify(value) }],
              details: {},
            }),
          );
        }),
    }),
    defineTool({
      name: "workflow_get_task",
      label: "查询工作流任务",
      description:
        "读取当前 Agent 所属工作流任务；完成时交付文件至工作区。建议每 2 秒查询一次。",
      parameters: Type.Object({ taskId: id }, { additionalProperties: false }),
      execute: async (_id, p) => result(() => service.get(context, p.taskId)),
    }),
    defineTool({
      name: "workflow_cancel_task",
      label: "取消工作流任务",
      description:
        "取消当前 Agent 的工作流任务及其活动节点。上游取消状态 unknown 表示可能仍在计算。",
      parameters: Type.Object({ taskId: id }, { additionalProperties: false }),
      execute: async (_id, p) =>
        result(() => service.cancel(context, p.taskId)),
    }),
  ];
}
async function result(operation: () => Promise<unknown>) {
  try {
    const text = JSON.stringify(await operation());
    if (Buffer.byteLength(text) > 128 * 1024)
      throw new DomainError(
        "REQUEST_FAILED",
        "工作流工具结果超过 128 KiB，请在工作流页面查看完整详情",
      );
    return { content: [{ type: "text" as const, text }], details: {} };
  } catch (error) {
    throw new Error(
      JSON.stringify({
        code:
          error instanceof DomainError ? error.code : "WORKFLOW_TOOL_FAILED",
        message: toSafePublicMessage(error, "工作流工具未返回可读异常"),
      }),
    );
  }
}
