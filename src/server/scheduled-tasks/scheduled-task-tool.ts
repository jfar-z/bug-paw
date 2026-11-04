import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CreateScheduledTaskInput, ScheduledTask, UpdateScheduledTaskInput, WritableScheduledTaskTarget } from "../../shared/scheduled-task-contracts";
import type { AgentSessionContext } from "../agent-system-prompt-configuration";
import { DomainError } from "../core/errors";
import { isTaskInScope, type ScheduledTaskAccess } from "./scheduled-task-repository";

/** 定时任务工具使用的服务入口，写入时传递服务端构造的访问范围。 */
interface ScheduledTaskToolService {
  list(agentId: string): Promise<ScheduledTask[]>;
  create(input: CreateScheduledTaskInput, access?: ScheduledTaskAccess): Promise<ScheduledTask>;
  update(taskId: string, input: UpdateScheduledTaskInput, access?: ScheduledTaskAccess): Promise<ScheduledTask | undefined>;
  remove(taskId: string, access?: ScheduledTaskAccess): Promise<void>;
}

const scheduleSchema = Type.Union([
  Type.Object({ type: Type.Literal("interval"), unit: Type.Union([Type.Literal("minute"), Type.Literal("hour")]), value: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("cron"), expression: Type.String({ minLength: 1 }), timezone: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("once"), runAt: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);
const targetSchema = Type.Union([
  Type.Object({ type: Type.Literal("current_session") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("new_session"), archiveAfterCompletion: Type.Boolean() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("existing_session"), sessionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

/**
 * 创建绑定当前会话身份的工具，模型只选择操作范围，不能覆盖调用者身份。
 *
 * @param context 当前运行时的 Agent 与会话身份
 * @param service 定时任务应用服务
 */
export function createScheduledTasksTool(context: AgentSessionContext, service: ScheduledTaskToolService) {
  return defineTool({
    name: "scheduled_tasks",
    label: "定时任务",
    description: "查询、创建、修改或删除定时任务。通常使用 scope=current_session，仅包含绑定到当前会话执行的任务；只有用户明确要求跨会话或新会话任务时使用 scope=agent，仍限当前 Agent。target.type=current_session 由服务端解析真实会话 ID。无关或不修改的字段必须传 null。Cron 使用五段表达式和 IANA 时区。",
    promptSnippet: "用 scheduled_tasks 管理定时任务，通常选择 current_session；不得把其他目标会话的任务当成本会话任务。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
      scope: Type.Union([Type.Literal("current_session"), Type.Literal("agent")], { description: "本会话任务使用 current_session；用户明确要求当前 Agent 全部任务或新会话执行任务时使用 agent。" }),
      taskId: Type.Union([Type.String({ minLength: 1 }), Type.Null()], { description: "update/delete 必填；list/create 传 null。" }),
      name: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      prompt: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
      enabled: Type.Union([Type.Boolean(), Type.Null()]),
      schedule: Type.Union([scheduleSchema, Type.Null()]),
      target: Type.Union([targetSchema, Type.Null()]),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      const access: ScheduledTaskAccess = {
        agentId: context.agentId,
        ...(params.scope === "current_session" ? { sessionId: context.sessionId } : {}),
      };
      const fields = [params.name, params.prompt, params.enabled, params.schedule, params.target];
      if ((params.action === "list" || params.action === "create") && params.taskId !== null) {
        throw new DomainError("VALIDATION_FAILED", "list/create 必须传 taskId=null");
      }
      if ((params.action === "list" || params.action === "delete") && fields.some((value) => value !== null)) {
        throw new DomainError("VALIDATION_FAILED", "list/delete 的 name、prompt、enabled、schedule、target 必须全部为 null");
      }
      if (params.action === "list") {
        const tasks = (await service.list(context.agentId)).filter((task) => isTaskInScope(task, access));
        return success({ scope: params.scope, currentSessionId: context.sessionId, tasks: tasks.map(presentTask) });
      }
      const target: WritableScheduledTaskTarget | null = params.target?.type === "current_session"
        ? { type: "existing_session", sessionId: context.sessionId }
        : params.target;
      if (target && !isTaskInScope({ agentId: context.agentId, target }, access)) {
        throw new DomainError("FORBIDDEN", "current_session 范围不能创建或改绑到其他目标；只有用户明确要求其他目标时才可使用 agent 范围");
      }
      if (params.action === "create") {
        if (!params.name || !params.prompt || params.enabled === null || !params.schedule || !target) {
          throw new DomainError("VALIDATION_FAILED", "创建任务需要非 null 的 name、prompt、enabled、schedule 和 target");
        }
        return success(presentTask(await service.create({
          agentId: context.agentId,
          name: params.name,
          prompt: params.prompt,
          enabled: params.enabled,
          schedule: params.schedule,
          target,
        }, access)));
      }
      if (!params.taskId) throw new DomainError("VALIDATION_FAILED", "修改或删除任务需要 taskId");
      const task = (await service.list(context.agentId)).find((item) => item.id === params.taskId && isTaskInScope(item, access));
      if (!task) throw new DomainError("SCHEDULED_TASK_NOT_FOUND", "指定定时任务不存在于本次操作范围内；不能依据其他会话任务推断本会话任务");
      if (params.action === "delete") {
        await service.remove(task.id, access);
        return success({ deletedTaskId: task.id, scope: params.scope, currentSessionId: context.sessionId });
      }
      const patch: UpdateScheduledTaskInput = {};
      if (params.name !== null) patch.name = params.name;
      if (params.prompt !== null) patch.prompt = params.prompt;
      if (params.enabled !== null) patch.enabled = params.enabled;
      if (params.schedule !== null) patch.schedule = params.schedule;
      if (target !== null) patch.target = target;
      if (Object.keys(patch).length === 0) throw new DomainError("VALIDATION_FAILED", "修改任务至少需要一个非 null 的可更新字段");
      const updated = await service.update(task.id, patch, access);
      if (!updated) throw new DomainError("SCHEDULED_TASK_NOT_FOUND", "定时任务在修改前已删除");
      return success(presentTask(updated));
    },
  });

  /** 每个返回任务显式标记目标是否为当前会话，避免把 Agent 列表误读为会话列表。 */
  function presentTask(task: ScheduledTask) {
    return { ...task, targetsCurrentSession: isTaskInScope(task, context) };
  }
}

/** 返回提供给 Pi 模型的结构化成功结果。 */
function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}
