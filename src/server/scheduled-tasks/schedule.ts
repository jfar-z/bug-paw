import { Cron } from "croner";
import type { ScheduledTaskSchedule } from "../../shared/scheduled-task-contracts";

/** 返回容器当前使用的 IANA 时区。 */
export function serverTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return timeZone === "UTC" ? "Etc/UTC" : timeZone;
}

/** 返回浏览器和服务端共同支持的时区候选。 */
export function timeZoneOptions(): string[] {
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([serverTimeZone(), ...zones])].sort();
}

/** 校验调度定义。 */
export function validateSchedule(schedule: ScheduledTaskSchedule): void {
  if (schedule.type === "interval") {
    if (!Number.isInteger(schedule.value) || schedule.value < 1) throw new Error("间隔必须是正整数");
    return;
  }
  if (schedule.type === "once") {
    if (Number.isNaN(Date.parse(schedule.runAt))) throw new Error("一次性任务执行时间无效");
    return;
  }
  if (schedule.expression.trim().split(/\s+/u).length !== 5) throw new Error("Cron 表达式必须包含五段");
  if (!timeZoneOptions().includes(schedule.timezone)) throw new Error("时区无效");
  new Cron(schedule.expression, { timezone: schedule.timezone, mode: "5-part" });
}

/** 计算指定时间之后的首次触发时间。 */
export function nextRunAt(schedule: ScheduledTaskSchedule, from: Date): string {
  validateSchedule(schedule);
  if (schedule.type === "interval") {
    const unitMs = schedule.unit === "minute" ? 60_000 : 3_600_000;
    return new Date(from.getTime() + schedule.value * unitMs).toISOString();
  }
  if (schedule.type === "once") {
    const runAt = new Date(schedule.runAt);
    if (runAt.getTime() <= from.getTime()) throw new Error("一次性任务执行时间必须晚于当前时间");
    return runAt.toISOString();
  }
  const next = new Cron(schedule.expression, { timezone: schedule.timezone, mode: "5-part" }).nextRun(from);
  if (!next) throw new Error("Cron 未找到后续执行时间");
  return next.toISOString();
}
