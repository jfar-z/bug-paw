import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CreateScheduledTaskInput, ScheduledTask, ScheduledTaskSchedule, UpdateScheduledTaskInput, WritableScheduledTaskTarget } from "../../shared/scheduled-task-contracts";

interface ScheduledTaskToolService {
  list(agentId: string): Promise<ScheduledTask[]>;
  create(input: CreateScheduledTaskInput): Promise<ScheduledTask>;
  update(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask | undefined>;
  remove(taskId: string): Promise<void>;
}

const scheduleSchema = Type.Union([
  Type.Object({ type: Type.Literal("interval"), unit: Type.Union([Type.Literal("minute"), Type.Literal("hour")]), value: Type.Integer({ minimum: 1 }) }),
  Type.Object({ type: Type.Literal("cron"), expression: Type.String({ minLength: 1 }), timezone: Type.String({ minLength: 1 }) }),
  Type.Object({ type: Type.Literal("once"), runAt: Type.String({ minLength: 1 }) }),
]);
const targetSchema = Type.Union([
  Type.Object({ type: Type.Literal("new_session"), archiveAfterCompletion: Type.Boolean() }),
  Type.Object({ type: Type.Literal("existing_session"), sessionId: Type.String({ minLength: 1 }) }),
]);

/**
 * 创建仅能访问当前 Agent 任务的 Pi SDK 原生工具。
 *
 * @param agentId 当前 Pi Runtime 所属 Agent
 * @param service 定时任务应用服务
 */
export function createScheduledTasksTool(agentId: string, service: ScheduledTaskToolService) {
  return defineTool({
    name: "scheduled_tasks",
    label: "定时任务",
    description: "查询、创建、修改或删除当前 Agent 的定时任务。Cron 使用五段表达式和 IANA 时区。",
    promptSnippet: "用 scheduled_tasks 管理当前 Agent 的定时任务。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("update"), Type.Literal("delete")]),
      taskId: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1 })),
      prompt: Type.Optional(Type.String({ minLength: 1 })),
      enabled: Type.Optional(Type.Boolean()),
      schedule: Type.Optional(scheduleSchema),
      target: Type.Optional(targetSchema),
    }),
    async execute(_toolCallId, params) {
      try {
        if (params.action === "list") {
          return success(await service.list(agentId));
        }
        if (params.action === "create") {
          if (!params.name || !params.prompt || params.enabled === undefined || !params.schedule || !params.target) {
            return failure("创建任务需要 name、prompt、enabled、schedule 和 target。");
          }
          return success(await service.create({
            agentId,
            name: params.name,
            prompt: params.prompt,
            enabled: params.enabled,
            schedule: params.schedule as ScheduledTaskSchedule,
            target: params.target as WritableScheduledTaskTarget,
          }));
        }
        if (!params.taskId) {
          return failure("修改或删除任务需要 taskId。");
        }
        const task = (await service.list(agentId)).find((item) => item.id === params.taskId);
        if (!task) {
          return failure("找不到当前 Agent 的定时任务。");
        }
        if (params.action === "delete") {
          await service.remove(task.id);
          return success({ deletedTaskId: task.id });
        }
        const patch: UpdateScheduledTaskInput = {};
        if (params.name !== undefined) patch.name = params.name;
        if (params.prompt !== undefined) patch.prompt = params.prompt;
        if (params.enabled !== undefined) patch.enabled = params.enabled;
        if (params.schedule !== undefined) patch.schedule = params.schedule as ScheduledTaskSchedule;
        if (params.target !== undefined) patch.target = params.target as WritableScheduledTaskTarget;
        if (Object.keys(patch).length === 0) {
          return failure("修改任务至少需要一个可更新字段。");
        }
        return success(await service.update(task.id, patch));
      } catch (error) {
        return failure(error instanceof Error ? error.message : "定时任务操作失败");
      }
    },
  });
}

/** 返回提供给 Pi 模型的结构化成功结果。 */
function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

/** 返回可供 Pi 模型纠正参数的失败结果。 */
function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: {} };
}
