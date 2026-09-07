import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { AigcAgentError, type AigcAgentContext, type AigcAgentService } from "./aigc-agent-service";

/** 为当前会话创建固定名称工具，授权仍由 SDK 和应用服务分别校验。 */
export function createAigcAgentTools(context: AigcAgentContext, service: AigcAgentService) {
  // 字段列表属于工具对象内部的属性，不是工具 parameters 根 Schema。
  const parameterEntries = Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 80 }),
    text: Type.Optional(Type.String({ maxLength: 20_000 })),
    number: Type.Optional(Type.Number()),
    boolean: Type.Optional(Type.Boolean()),
    path: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024, description: "当前 Agent 工作区相对路径；媒体字段统一使用此值，服务端按渠道协议上传或发布" })),
  }, { additionalProperties: false }), { maxItems: 100, description: "每项按字段类型只提供 text、number、boolean、path 中的一种值" });
  return [
    defineTool({
      name: "aigc_list_interfaces", label: "查询 AIGC 接口",
      description: "分页查询已发布接口；传 interfaceId 获取执行前必须读取的参数定义。",
      parameters: Type.Object({
        interfaceId: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
      }, { additionalProperties: false }),
      execute: async (_id, params) => result(() => service.list(context, params)),
    }),
    defineTool({
      name: "aigc_run", label: "提交 AIGC 任务",
      description: "调用已发布接口异步生成媒体。先查询接口字段；同一次生成的重试必须复用 requestKey，改变 key 表示明确创建新任务。",
      promptSnippet: "提交后使用 aigc_get_task 查询进度，绝不通过重复提交查询状态；生成任务可能计费。",
      parameters: Type.Object({
        interfaceId: Type.String({ minLength: 1, maxLength: 120 }),
        requestKey: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
        parameters: parameterEntries,
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => result(() => service.run(context, params, signal)),
    }),
    defineTool({
      name: "aigc_get_task", label: "查询 AIGC 任务",
      description: "读取当前 Agent 的任务进度和产物；查询间隔至少 2 秒。完成时返回可用于 pi_agent_files 的工作区相对路径。",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id, params) => result(() => service.get(context, params.taskId)),
    }),
    defineTool({
      name: "aigc_cancel_task", label: "取消 AIGC 任务",
      description: "取消当前 Agent 的任务。仅 upstreamCancellation=confirmed 表示上游已确认停止；unknown 时可能仍在计算或计费。",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id, params) => result(() => service.cancel(context, params.taskId)),
    }),
    defineTool({
      name: "aigc_run_and_wait", label: "生成并等待 AIGC 产物",
      description: "提交生成任务并阻塞等待结果，成功后直接交付文件。参数与 aigc_run 相同，同一次生成必须复用 requestKey。最多等待 30 分钟；超时或中止聊天只结束等待，不取消后台任务。",
      promptSnippet: "需要本次对话直接获得产物时使用 aigc_run_and_wait；等待超时后保留任务 ID，不重复创建任务。",
      parameters: Type.Object({
        interfaceId: Type.String({ minLength: 1, maxLength: 120 }),
        requestKey: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
        parameters: parameterEntries,
      }, { additionalProperties: false }),
      execute: async (_id, params, signal, onUpdate) => result(() => service.runAndWait(context, params, signal, (state) => {
        onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ status: "waiting", data: state }) }], details: {} });
      })),
    }),
  ];
}

/** 工具输出限制大小，失败抛出脱敏错误以让 Pi 正确标记 isError。 */
async function result(operation: () => Promise<unknown>) {
  try {
    const text = JSON.stringify({ status: "ok", data: await operation() });
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new AigcAgentError("AIGC_RESULT_TOO_LARGE", "接口字段过多，请在 AIGC 工作台精简发布参数");
    return { content: [{ type: "text" as const, text }], details: {} };
  } catch (error) {
    const code = error instanceof AigcAgentError ? error.code : error instanceof TypeError ? "AIGC_INPUT_INVALID" : "AIGC_OPERATION_FAILED";
    const message = error instanceof AigcAgentError || error instanceof TypeError ? error.message : "AIGC 操作失败，请检查工作区文件和 AIGC 工作台状态，不要自动重复提交";
    throw new Error(JSON.stringify({ code, message }));
  }
}
