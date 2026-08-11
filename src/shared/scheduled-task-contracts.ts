/** 定时任务调度定义。 */
export type ScheduledTaskSchedule =
  | { type: "interval"; unit: "minute" | "hour"; value: number }
  | { type: "cron"; expression: string; timezone: string }
  | { type: "once"; runAt: string };

/** 用户可为定时任务选择的目标会话定义。 */
export type WritableScheduledTaskTarget =
  | { type: "new_session"; archiveAfterCompletion: boolean }
  | { type: "existing_session"; sessionId: string };

/** 会话删除后保留的只读任务目标。 */
export interface DeletedSessionTaskTarget {
  type: "deleted_session";
  sessionId: string;
  sessionName: string;
}

/** 定时任务当前持有的目标会话定义。 */
export type ScheduledTaskTarget = WritableScheduledTaskTarget | DeletedSessionTaskTarget;

/** 判断任务是否因原目标会话删除而不可执行。 */
export function isDeletedSessionTarget(target: ScheduledTaskTarget): target is DeletedSessionTaskTarget {
  return target.type === "deleted_session";
}

/** 定时任务数据。 */
export interface ScheduledTask {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: ScheduledTaskSchedule;
  target: ScheduledTaskTarget;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
}

/** 创建任务时允许提交的字段；缺失目标只能由服务端删除事务生成。 */
export type CreateScheduledTaskInput = Pick<ScheduledTask, "agentId" | "name" | "prompt" | "enabled" | "schedule"> & {
  target: WritableScheduledTaskTarget;
};

/** 更新任务时允许提交的字段。 */
export type UpdateScheduledTaskInput = Partial<Omit<CreateScheduledTaskInput, "agentId">>;

/** 任务运行状态。 */
export type ScheduledTaskRunStatus = "running" | "completed" | "failed" | "skipped";

/** 任务执行来源。 */
export type ScheduledTaskTrigger = "scheduled" | "manual";

/** 单次任务执行记录。 */
export interface ScheduledTaskRun {
  id: string;
  taskId: string;
  trigger: ScheduledTaskTrigger;
  status: ScheduledTaskRunStatus;
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  prompt: string;
  reason?: string;
  archived?: boolean;
}
