import type { FastifyInstance } from "fastify";
import type { SessionBulkAction, SessionBulkTarget } from "../../shared/session-bulk-contracts";
import type { PiRuntimeGateway } from "../pi-runtime";
import type { RuntimeSupervisor } from "../runtime/runtime-supervisor";
import type { SessionMetadataStore } from "../session-metadata";
import { resolveSessionAgentId } from "../session-agent";
import type { SessionBulkService } from "../sessions/session-bulk-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";
import { sendRuntimeError } from "./runtime-error";

interface SessionRouteDependencies {
  authService: AuthService;
  runtime?: PiRuntimeGateway;
  runtimeSupervisor?: RuntimeSupervisor;
  sessionMetadata?: SessionMetadataStore;
  scheduledTasks?: { boundTasks(sessionId: string): Promise<Array<unknown>> };
  sessionBulk?: SessionBulkService;
  assertCanCreateSession?: (agentId: string) => Promise<void>;
}

/**
 * 注册会话列表、创建、恢复和模型切换接口。
 */
export function registerSessionRoutes(app: FastifyInstance, dependencies: SessionRouteDependencies): void {
  app.get<{ Querystring: { archived?: string; agentId?: string } }>("/api/sessions", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    if (request.query.archived !== undefined && request.query.archived !== "true" && request.query.archived !== "false") {
      return sendApiError(reply, 400, "INVALID_ARCHIVED_FILTER", "归档筛选参数必须是 true 或 false");
    }
    const agentId = request.query.agentId ?? (dependencies.runtime ? "default" : undefined);
    if (!agentId) return sendApiError(reply, 400, "AGENT_REQUIRED", "读取 Session 必须指定 agentId");
    const acquired = await acquireRuntimeForAgent(dependencies, agentId);
    try {
      const sessions = await acquired.runtime.listSessions({ archived: request.query.archived === "true" });
      const enrichedSessions = await Promise.all(sessions.map(async (session) => ({
        ...session,
        agentId,
        scheduledTaskCount: (await dependencies.scheduledTasks?.boundTasks(session.id) ?? []).length,
      })));
      return reply.send({ sessions: enrichedSessions });
    } finally {
      acquired.release();
    }
  });

  app.post("/api/sessions", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    const agentId = typeof body.agentId === "string" ? body.agentId : dependencies.runtime ? "default" : undefined;
    if (!agentId) {
      return sendApiError(reply, 400, "AGENT_REQUIRED", "创建 Session 必须指定 agentId");
    }
    await dependencies.assertCanCreateSession?.(agentId);
    const acquired = await acquireRuntimeForAgent(dependencies, agentId);
    try {
      const created = await acquired.runtime.createSession();
      try {
        await dependencies.sessionMetadata?.assignAgent(created.id, agentId);
      } catch (assignError) {
        // Pi 已创建 JSONL 后 SQLite 归属写入仍可能失败，必须补偿删除，
        // 否则会留下列表可见但无法解析归属的孤儿 Session。
        try {
          await acquired.runtime.discardUnassignedSession(created.id);
        } catch (cleanupError) {
          throw new AggregateError([assignError, cleanupError], "Session 归属写入失败且孤儿会话清理失败");
        }
        throw assignError;
      }
      return reply.code(201).send({ ...created, agentId });
    } finally {
      acquired.release();
    }
  });

  app.post("/api/sessions/bulk/preview", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const input = readBulkBody(request.body, false);
    if (!input) return sendApiError(reply, 400, "VALIDATION_FAILED", "批量会话预览参数格式不正确");
    if (!dependencies.sessionBulk) throw new Error("Session 批量应用服务尚未配置");
    try {
      return reply.send(await dependencies.sessionBulk.preview(input.action, input.target));
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.post("/api/sessions/bulk", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const input = readBulkBody(request.body, true);
    if (!input?.fingerprint) return sendApiError(reply, 400, "VALIDATION_FAILED", "批量会话执行参数格式不正确");
    if (!dependencies.sessionBulk) throw new Error("Session 批量应用服务尚未配置");
    try {
      return reply.send(await dependencies.sessionBulk.execute({
        action: input.action,
        target: input.target,
        fingerprint: input.fingerprint,
      }));
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    try {
      const resolved = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        return reply.send({ ...await resolved.runtime.openSession(request.params.id), agentId: resolved.agentId });
      } finally {
        resolved.release();
      }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; branch?: string } }>(
    "/api/sessions/:id/history",
    async (request, reply) => {
      if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
      if (!request.query.before || !request.query.branch) {
        return sendApiError(reply, 400, "VALIDATION_FAILED", "历史分页参数不完整");
      }
      try {
        const resolved = await acquireRuntimeForSession(dependencies, request.params.id);
        try {
          await resolved.runtime.openSession(request.params.id);
          return reply.send(await resolved.runtime.loadHistoryPage(
            request.params.id,
            request.query.before,
            request.query.branch,
          ));
        } finally {
          resolved.release();
        }
      } catch (error) {
        return sendRuntimeError(reply, error);
      }
    },
  );

  app.put<{ Params: { id: string } }>("/api/sessions/:id/model", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.provider !== "string" || typeof body.modelId !== "string") {
      return sendApiError(reply, 400, "INVALID_MODEL", "模型参数格式不正确");
    }
    try {
      const acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        await acquired.runtime.openSession(request.params.id);
        await acquired.runtime.setModel(request.params.id, body.provider, body.modelId);
        return reply.code(204).send();
      } finally {
        acquired.release();
      }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.name !== "string" || !body.name.trim() || [...body.name.trim()].length > 120) {
      return sendApiError(reply, 400, "INVALID_SESSION_NAME", "会话名称不能为空且不能超过 120 个字符");
    }
    try {
      const acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        await acquired.runtime.renameSession(request.params.id, body.name);
        return reply.code(204).send();
      } finally { acquired.release(); }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/archive", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    try {
      const acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        await acquired.runtime.archiveSession(request.params.id);
        return reply.code(204).send();
      } finally { acquired.release(); }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id/archive", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    try {
      const acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        await acquired.runtime.unarchiveSession(request.params.id);
        return reply.code(204).send();
      } finally { acquired.release(); }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { confirmBoundTasks?: string; deleteScheduledTasks?: string } }>("/api/sessions/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    try {
      if (!dependencies.sessionBulk) throw new Error("Session 批量应用服务尚未配置");
      const preview = await dependencies.sessionBulk.preview("delete", {
        mode: "selected",
        sessionIds: [request.params.id],
      });
      const confirmed = request.query.confirmBoundTasks === "true" || request.query.deleteScheduledTasks === "true";
      if (preview.tasks.length && !confirmed) {
        return sendApiError(reply, 409, "SCHEDULED_TASKS_BOUND", `会话已绑定 ${preview.tasks.length} 个定时任务，请确认停用任务后删除会话`);
      }
      await dependencies.sessionBulk.execute({
        action: "delete",
        target: preview.target,
        fingerprint: preview.fingerprint,
      });
      return reply.code(204).send();
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });
}

async function acquireRuntimeForAgent(
  dependencies: SessionRouteDependencies,
  agentId: string,
): Promise<{ runtime: PiRuntimeGateway; release(): void }> {
  if (dependencies.runtimeSupervisor) {
    const lease = await dependencies.runtimeSupervisor.acquire(agentId);
    return { runtime: lease.runtime, release: lease.release };
  }
  if (dependencies.runtime) {
    return { runtime: dependencies.runtime, release: () => undefined };
  }
  throw new Error("Session Runtime 尚未配置");
}

async function acquireRuntimeForSession(
  dependencies: SessionRouteDependencies,
  sessionId: string,
): Promise<{ runtime: PiRuntimeGateway; agentId: string; release(): void }> {
  if (!dependencies.runtimeSupervisor) {
    return { ...await acquireRuntimeForAgent(dependencies, "default"), agentId: "default" };
  }
  const agentId = await resolveSessionAgentId(sessionId, dependencies.sessionMetadata);
  return { ...await acquireRuntimeForAgent(dependencies, agentId), agentId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验批量接口输入，避免将无界 ID 集合传入数据库。 */
function readBulkBody(value: unknown, requireFingerprint: boolean): {
  action: SessionBulkAction;
  target: SessionBulkTarget;
  fingerprint?: string;
} | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, requireFingerprint ? ["action", "target", "fingerprint"] : ["action", "target"])) {
    return undefined;
  }
  if (value.action !== "archive" && value.action !== "restore" && value.action !== "delete") return undefined;
  const target = readBulkTarget(value.target);
  if (!target) return undefined;
  const validCombination = target.mode === "selected"
    ? value.action === "archive" || value.action === "delete"
    : value.action === "restore" || value.action === "delete";
  if (!validCombination) return undefined;
  if (requireFingerprint && (typeof value.fingerprint !== "string" || value.fingerprint.length === 0)) return undefined;
  return {
    action: value.action,
    target,
    ...(typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}),
  };
}

/** 解析受限或服务端解析的批量目标，拒绝判别分支中的额外字段。 */
function readBulkTarget(value: unknown): SessionBulkTarget | undefined {
  if (!isRecord(value) || typeof value.mode !== "string") return undefined;
  if (value.mode === "selected") {
    if (!hasOnlyKeys(value, ["mode", "sessionIds"])) return undefined;
    if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0 || value.sessionIds.length > 200) return undefined;
    if (!value.sessionIds.every((id) => typeof id === "string" && id.trim().length > 0)) return undefined;
    return { mode: "selected", sessionIds: value.sessionIds };
  }
  if (value.mode === "all_archived") {
    if (!hasOnlyKeys(value, ["mode", "agentId"])) return undefined;
    if (typeof value.agentId !== "string" || value.agentId.trim().length === 0) return undefined;
    return { mode: "all_archived", agentId: value.agentId };
  }
  return undefined;
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).length === allowed.size && Object.keys(value).every((key) => allowed.has(key));
}
