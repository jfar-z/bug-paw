import { isDeletedSessionTarget, type CreateScheduledTaskInput, type ScheduledTaskRun, type ScheduledTaskTarget, type ScheduledTaskTrigger, type UpdateScheduledTaskInput } from "../../shared/scheduled-task-contracts";
import { nextRunAt, validateSchedule } from "./schedule";
import type { ScheduledTaskRepository } from "./scheduled-task-repository";
import { DomainError, toSafePublicMessage } from "../core/errors";

interface TaskRuntime {
  createSession(): Promise<{ id: string }>;
  discardUnassignedSession?(sessionId: string): Promise<void>;
  startPrompt(sessionId: string, text: string): Promise<unknown>;
  isBusy?(): boolean;
  onIdle?(listener: () => void): () => void;
  abortAll?(): Promise<number>;
}

interface ScheduledTaskServiceOptions {
  store: ScheduledTaskRepository;
  acquireRuntime(agentId: string): Promise<{ runtime: TaskRuntime; release(): void }>;
  assignSession?(sessionId: string, agentId: string): Promise<void>;
  archiveSession?(sessionId: string): Promise<void>;
  sessionIsPersisted?(agentId: string, sessionId: string): Promise<boolean>;
  assertSessionRunnable?(agentId: string, sessionId: string): void;
  onBackgroundError?(error: { code: "SCHEDULED_TASK_BACKGROUND_FAILED"; taskId: string; message: string }): void;
}

/** 协调任务校验、会话创建与消息执行。 */
export function createScheduledTaskService(options: ScheduledTaskServiceOptions) {
  const active = new Set<string>();
  const executions = new Set<Promise<ScheduledTaskRun>>();
  const activeRuntimes = new Set<TaskRuntime>();
  const cancelIdleWaits = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  const MAX_TIMER_DELAY_MS = 2_147_000_000;

  /** 拒绝把可跨重启执行的任务绑定到尚无 Pi JSONL 的空 Session。 */
  async function validatePersistentTarget(agentId: string, target: ScheduledTaskTarget): Promise<void> {
    if (target.type !== "existing_session" || !options.sessionIsPersisted) return;
    if (!await options.sessionIsPersisted(agentId, target.sessionId)) {
      throw new DomainError("VALIDATION_FAILED", "空会话尚未产生可恢复记录，不能绑定定时任务");
    }
  }

  /** 将重启期间错过的触发点重置为从当前时刻开始的下一次执行。 */
  async function prepareNextRuns(): Promise<void> {
    const now = new Date();
    const tasks = await options.store.listAllTasks();
    await Promise.all(tasks.filter((task) => task.enabled).map(async (task) => {
      if (task.schedule.type === "once" && Date.parse(task.schedule.runAt) <= now.getTime()) {
        await options.store.updateTask(task.id, { enabled: false, nextRunAt: undefined } as UpdateScheduledTaskInput);
        return;
      }
      await options.store.updateTask(task.id, { nextRunAt: nextRunAt(task.schedule, now) } as UpdateScheduledTaskInput);
    }));
  }

  /** 为当前最早的已启用任务安装唯一的唤醒定时器。 */
  async function schedule(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (closing) return;
    const tasks = await options.store.listAllTasks();
    const next = tasks.filter((task) => task.enabled && task.nextRunAt).sort((left, right) => (left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? ""))[0];
    if (!next?.nextRunAt) return;
    const delay = Math.max(0, new Date(next.nextRunAt).getTime() - Date.now());
    const capped = delay > MAX_TIMER_DELAY_MS;
    timer = setTimeout(() => {
      const wake = capped ? schedule() : runNow(next.id, "scheduled").then(() => undefined);
      void wake.catch((error: unknown) => {
        options.onBackgroundError?.({
          code: "SCHEDULED_TASK_BACKGROUND_FAILED",
          taskId: next.id,
          message: toSafePublicMessage(error, "定时任务后台执行失败"),
        });
      });
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref?.();
  }

  /** 等待 Pi Runtime 通知本 Agent 没有进行中的生成。 */
  function idleAfterPrompt(runtime: TaskRuntime): { wait: Promise<void>; cancel(): void; dispose(): void } {
    if (!runtime.onIdle) return { wait: Promise.resolve(), cancel: () => undefined, dispose: () => undefined };
    let unsubscribe: () => void = () => undefined;
    let rejectWait: (error: Error) => void = () => undefined;
    let settled = false;
    const wait = new Promise<void>((resolve, reject) => {
      rejectWait = reject;
      unsubscribe = runtime.onIdle?.(() => resolve()) ?? (() => undefined);
    }).finally(() => {
      settled = true;
    });
    return {
      wait,
      cancel() {
        if (!settled) rejectWait(new DomainError("OPERATION_ABORTED", "服务正在关闭，定时任务已中止"));
      },
      dispose: () => unsubscribe(),
    };
  }

  async function execute(taskId: string, trigger: ScheduledTaskTrigger): Promise<ScheduledTaskRun> {
    let task = await options.store.getTask(taskId);
    if (!task) throw new Error("定时任务不存在");
    if (isDeletedSessionTarget(task.target)) {
      throw new DomainError("SCHEDULED_TASK_TARGET_MISSING", "原目标会话已删除，请重新选择任务目标");
    }
    if (task.target.type === "existing_session") {
      options.assertSessionRunnable?.(task.agentId, task.target.sessionId);
    }
    if (trigger === "scheduled") {
      const claimed = await options.store.claimDueTask(taskId, new Date());
      if (!claimed) {
        await schedule();
        return options.store.appendRun({ taskId: task.id, trigger, status: "skipped", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), prompt: `这是定时任务发出的消息\n\n${task.prompt}`, reason: "任务已禁用、重排或尚未到期" });
      }
      task = claimed;
    }
    const text = `这是定时任务发出的消息\n\n${task.prompt}`;
    const startedAt = new Date().toISOString();
    if (trigger === "scheduled") await schedule();
    if (active.has(task.id)) return options.store.appendRun({ taskId: task.id, trigger, status: "skipped", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), prompt: text, reason: "任务正在执行中" });
    active.add(task.id);
    let run: ScheduledTaskRun | undefined;
    let runtimeLease: Awaited<ReturnType<ScheduledTaskServiceOptions["acquireRuntime"]>> | undefined;
    let idle: ReturnType<typeof idleAfterPrompt> | undefined;
    try {
      run = await options.store.appendRun({ taskId: task.id, trigger, status: "running", startedAt, prompt: text });
      runtimeLease = await options.acquireRuntime(task.agentId);
      const runtime = runtimeLease.runtime;
      activeRuntimes.add(runtime);
      if (task.target.type === "existing_session" && runtime.isBusy?.()) {
        return (await options.store.updateRun(run.id, { status: "skipped", finishedAt: new Date().toISOString(), reason: "会话正在生成中" }))!;
      }
      const sessionId = task.target.type === "new_session" ? (await runtime.createSession()).id : task.target.sessionId;
      if (task.target.type === "new_session") {
        try {
          await options.assignSession?.(sessionId, task.agentId);
        } catch (assignError) {
          try {
            await runtime.discardUnassignedSession?.(sessionId);
          } catch (cleanupError) {
            throw new AggregateError([assignError, cleanupError], "定时任务 Session 归属写入失败且孤儿会话清理失败");
          }
          throw assignError;
        }
      }
      idle = idleAfterPrompt(runtime);
      cancelIdleWaits.add(idle.cancel);
      await runtime.startPrompt(sessionId, text);
      await idle.wait;
      run = (await options.store.updateRun(run.id, { status: "completed", finishedAt: new Date().toISOString(), sessionId }))!;
      if (task.target.type === "new_session" && task.target.archiveAfterCompletion) {
        await options.archiveSession?.(sessionId);
        run = (await options.store.updateRun(run.id, { archived: true }))!;
      }
      return run;
    } catch (error) {
      if (!run) throw error;
      const reason = toSafePublicMessage(error, "定时任务执行失败");
      options.onBackgroundError?.({ code: "SCHEDULED_TASK_BACKGROUND_FAILED", taskId: task.id, message: reason });
      return (await options.store.updateRun(run.id, { status: "failed", finishedAt: new Date().toISOString(), reason }))!;
    } finally {
      idle?.dispose();
      if (idle) cancelIdleWaits.delete(idle.cancel);
      if (runtimeLease) activeRuntimes.delete(runtimeLease.runtime);
      runtimeLease?.release();
      active.delete(task.id);
    }
  }

  /** 注册一次可排空的任务执行，关闭开始后拒绝新的运行。 */
  async function runNow(taskId: string, trigger: ScheduledTaskTrigger = "manual"): Promise<ScheduledTaskRun> {
    if (closing) throw new DomainError("OPERATION_ABORTED", "服务正在关闭，不能启动定时任务");
    const execution = execute(taskId, trigger);
    executions.add(execution);
    try {
      return await execution;
    } finally {
      executions.delete(execution);
    }
  }

  /** 停止调度、请求中止运行并等待所有持久化收尾完成。 */
  async function stopAndDrain(timeoutMs?: number): Promise<boolean> {
    closing = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    // 中止 RPC 只是促使执行尽快结束；真正的关库条件是 execution 已完成终态持久化。
    void Promise.allSettled([...activeRuntimes].map((runtime) => runtime.abortAll?.()));
    for (const cancel of [...cancelIdleWaits]) cancel();
    const drained = Promise.allSettled([...executions]).then(() => true);
    if (timeoutMs === undefined) return drained;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      drained,
      new Promise<false>((resolve) => { deadlineTimer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    return result;
  }

  return {
    async create(task: CreateScheduledTaskInput) { if (closing) throw new DomainError("OPERATION_ABORTED", "服务正在关闭"); validateSchedule(task.schedule); await validatePersistentTarget(task.agentId, task.target); const created = await options.store.createTask({ ...task, nextRunAt: nextRunAt(task.schedule, new Date()) } as CreateScheduledTaskInput); await schedule(); return created; },
    async update(id: string, input: UpdateScheduledTaskInput) { if (closing) throw new DomainError("OPERATION_ABORTED", "服务正在关闭"); if (input.schedule) validateSchedule(input.schedule); const current = await options.store.getTask(id); if (!current) return undefined; await validatePersistentTarget(current.agentId, input.target ?? current.target); const updated = await options.store.updateTask(id, { ...input, ...(input.schedule ? { nextRunAt: nextRunAt(input.schedule, new Date()) } : {}) }); await schedule(); return updated; },
    async remove(id: string) { if (closing) throw new DomainError("OPERATION_ABORTED", "服务正在关闭"); await options.store.removeTask(id); await schedule(); },
    runNow,
    list: options.store.listTasks,
    listRuns: options.store.listRuns,
    async start() { if (closing) throw new DomainError("OPERATION_ABORTED", "服务已经关闭"); await prepareNextRuns(); await schedule(); },
    stopAndDrain,
    boundTasks: options.store.listBoundTasks,
    removeTasksForSession: options.store.removeTasksForSession,
  };
}
