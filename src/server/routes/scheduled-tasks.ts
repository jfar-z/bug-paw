import type { FastifyInstance } from "fastify";
import type { CreateScheduledTaskInput, UpdateScheduledTaskInput } from "../../shared/scheduled-task-contracts";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";
import { serverTimeZone, timeZoneOptions } from "../scheduled-tasks/schedule";
import { toSafePublicMessage } from "../core/errors";

interface TaskService { list(agentId: string): Promise<unknown>; create(input: CreateScheduledTaskInput): Promise<unknown>; update(taskId: string, input: UpdateScheduledTaskInput): Promise<unknown>; remove(taskId: string): Promise<void>; runNow(taskId: string): Promise<unknown>; listRuns(taskId: string): Promise<unknown> }

/** 注册定时任务管理接口。 */
export function registerScheduledTaskRoutes(app: FastifyInstance, dependencies: { authService: AuthService; service: TaskService }): void {
  app.get("/api/scheduled-tasks/timezones", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send({ serverTimeZone: serverTimeZone(), timezones: timeZoneOptions() });
  });
  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/scheduled-tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send({ tasks: await dependencies.service.list(request.params.agentId) });
  });
  app.patch<{ Params: { taskId: string } }>("/api/scheduled-tasks/:taskId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = parseUpdate(request.body);
    if (!body) return sendApiError(reply, 400, "INVALID_SCHEDULED_TASK", "定时任务参数无效");
    try { const task = await dependencies.service.update(request.params.taskId, body); return task ? reply.send(task) : sendApiError(reply, 404, "SCHEDULED_TASK_NOT_FOUND", "定时任务不存在"); }
    catch (error) { return sendApiError(reply, 400, "INVALID_SCHEDULED_TASK", toSafePublicMessage(error, "定时任务参数无效")); }
  });
  app.delete<{ Params: { taskId: string } }>("/api/scheduled-tasks/:taskId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    await dependencies.service.remove(request.params.taskId); return reply.code(204).send();
  });
  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/scheduled-tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = parseCreate(request.body, request.params.agentId);
    if (!body) return sendApiError(reply, 400, "INVALID_SCHEDULED_TASK", "定时任务参数无效");
    try { return reply.code(201).send(await dependencies.service.create(body)); }
    catch (error) { return sendApiError(reply, 400, "INVALID_SCHEDULED_TASK", toSafePublicMessage(error, "定时任务参数无效")); }
  });
  app.post<{ Params: { taskId: string } }>("/api/scheduled-tasks/:taskId/run", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try { return reply.code(202).send(await dependencies.service.runNow(request.params.taskId)); }
    catch { return sendApiError(reply, 404, "SCHEDULED_TASK_NOT_FOUND", "定时任务不存在"); }
  });
  app.get<{ Params: { taskId: string } }>("/api/scheduled-tasks/:taskId/runs", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send({ runs: await dependencies.service.listRuns(request.params.taskId) });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function parseCreate(value: unknown, agentId: string): CreateScheduledTaskInput | undefined {
  if (!isRecord(value) || !validText(value.name, 120) || !validText(value.prompt, 100_000) || typeof value.enabled !== "boolean") return undefined;
  const schedule = parseSchedule(value.schedule);
  const target = parseTarget(value.target);
  return schedule && target ? { agentId, name: value.name, prompt: value.prompt, enabled: value.enabled, schedule, target } : undefined;
}

function parseUpdate(value: unknown): UpdateScheduledTaskInput | undefined {
  if (!isRecord(value)) return undefined;
  const update: UpdateScheduledTaskInput = {};
  if (value.name !== undefined) { if (!validText(value.name, 120)) return undefined; update.name = value.name; }
  if (value.prompt !== undefined) { if (!validText(value.prompt, 100_000)) return undefined; update.prompt = value.prompt; }
  if (value.enabled !== undefined) { if (typeof value.enabled !== "boolean") return undefined; update.enabled = value.enabled; }
  if (value.schedule !== undefined) { const schedule = parseSchedule(value.schedule); if (!schedule) return undefined; update.schedule = schedule; }
  if (value.target !== undefined) { const target = parseTarget(value.target); if (!target) return undefined; update.target = target; }
  return update;
}

function parseSchedule(value: unknown): CreateScheduledTaskInput["schedule"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "interval" && (value.unit === "minute" || value.unit === "hour") && Number.isInteger(value.value) && (value.value as number) > 0) return { type: "interval", unit: value.unit, value: value.value as number };
  if (value.type === "cron" && validText(value.expression, 200) && validText(value.timezone, 100)) return { type: "cron", expression: value.expression, timezone: value.timezone };
  if (value.type === "once" && typeof value.runAt === "string" && Number.isFinite(Date.parse(value.runAt))) return { type: "once", runAt: value.runAt };
  return undefined;
}

function parseTarget(value: unknown): CreateScheduledTaskInput["target"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === "new_session" && typeof value.archiveAfterCompletion === "boolean") return { type: "new_session", archiveAfterCompletion: value.archiveAfterCompletion };
  if (value.type === "existing_session" && validText(value.sessionId, 200)) return { type: "existing_session", sessionId: value.sessionId };
  return undefined;
}

function validText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && [...value].length <= maxLength;
}
