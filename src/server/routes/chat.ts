import type { FastifyInstance } from "fastify";
import type { ChatEvent, PiRuntimeGateway } from "../pi-runtime";
import type { RuntimeSupervisor } from "../runtime/runtime-supervisor";
import type { SessionMetadataStore } from "../session-metadata";
import { resolveSessionAgentId } from "../session-agent";
import type { AuthService } from "./auth";
import type { WorkspaceFileInfo, WorkspaceFileService } from "../attachments";
import { compileAgentReferences, readAgentReferenceInputs, type AgentReferenceResolver } from "../agent-references";
import type { AgentReference } from "../../shared/agent-reference-contracts";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";
import { sendRuntimeError } from "./runtime-error";
import type { ChatApplicationService } from "../chat/chat-service";
import { SseConnection } from "../http/sse-connection";
import { DomainError } from "../core/errors";

interface ChatRouteDependencies {
  authService: AuthService;
  runtime?: PiRuntimeGateway;
  runtimeSupervisor?: RuntimeSupervisor;
  sessionMetadata?: SessionMetadataStore;
  heartbeatMs?: number;
  workspaceFiles?: WorkspaceFileService;
  referenceResolver?: AgentReferenceResolver;
  chatService?: ChatApplicationService;
}

/**
 * 注册消息生成、终止和 SSE 事件流接口。
 */
export function registerChatRoutes(app: FastifyInstance, dependencies: ChatRouteDependencies): void {
  app.post<{ Params: { id: string } }>("/api/sessions/:id/messages", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    const body = isRecord(request.body) ? request.body : {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const filePaths = readFilePaths(body.filePaths);
    const referenceInputs = readAgentReferenceInputs(body.references);
    const commandName = readCommandName(text);
    if (filePaths === "invalid" || referenceInputs === "invalid" || text.length > 100_000 || (!text && filePaths.length === 0 && referenceInputs.length === 0)) {
      return sendApiError(reply, 400, "INVALID_MESSAGE", "消息或附件无效，文本不能超过 100000 个字符");
    }
    try {
      if (dependencies.chatService) {
        const run = await dependencies.chatService.startTurn(request.params.id, {
          text,
          filePaths,
          references: referenceInputs,
        });
        return reply.code(202).send(run);
      }
      const acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        if (commandName && !(await acquired.runtime.listCommands()).some((command) => command.name === commandName)) {
          return sendApiError(reply, 400, "UNKNOWN_COMMAND", "当前 Agent 不支持该命令");
        }
        await acquired.runtime.openSession(request.params.id);
        const files = await resolveFiles(dependencies.workspaceFiles, acquired.agentId, filePaths);
        if (!files) {
          return sendApiError(reply, 400, "INVALID_ATTACHMENT", "文件不存在或不属于当前 Agent 工作目录");
        }
        const references = referenceInputs.length > 0
          ? await dependencies.referenceResolver?.resolve(acquired.agentId, referenceInputs)
          : [];
        if (!references) {
          return sendApiError(reply, 400, "INVALID_REFERENCE", "引用不存在或不属于当前 Agent");
        }
        const run = await acquired.runtime.startPrompt(request.params.id, buildPrompt(text, mergeReferences(references, files)), text);
        return reply.code(202).send(run);
      } finally {
        acquired.release();
      }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    try {
      if (dependencies.chatService) {
        await dependencies.chatService.abort(request.params.id);
        return reply.code(204).send();
      }
      const acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      try {
        await acquired.runtime.openSession(request.params.id);
        await acquired.runtime.abort(request.params.id);
        return reply.code(204).send();
      } finally {
        acquired.release();
      }
    } catch (error) {
      return sendRuntimeError(reply, error);
    }
  });

  app.post<{ Params: { id: string; entryId: string } }>("/api/sessions/:id/branches/:entryId/edit", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      if (!dependencies.chatService) return sendApiError(reply, 503, "REQUEST_FAILED", "会话树服务尚未就绪");
      return reply.send(await dependencies.chatService.editHistory(request.params.id, request.params.entryId));
    } catch (error) { return sendRuntimeError(reply, error); }
  });

  /**
   * 在指定历史用户消息下创建新分支。
   *
   * 编辑接口本身只读取历史内容，用户确认发送后才通过本接口变更 Pi 活跃分支。
   */
  app.post<{ Params: { id: string; entryId: string } }>("/api/sessions/:id/branches/:entryId/messages", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const filePaths = readFilePaths(body.filePaths);
    const referenceInputs = readAgentReferenceInputs(body.references);
    if (filePaths === "invalid" || referenceInputs === "invalid" || text.length > 100_000 || (!text && filePaths.length === 0 && referenceInputs.length === 0)) {
      return sendApiError(reply, 400, "INVALID_MESSAGE", "消息或附件无效，文本不能超过 100000 个字符");
    }
    try {
      if (!dependencies.chatService) return sendApiError(reply, 503, "REQUEST_FAILED", "会话树服务尚未就绪");
      return reply.code(202).send(await dependencies.chatService.startBranchTurn(request.params.id, request.params.entryId, {
        text,
        filePaths,
        references: referenceInputs,
      }));
    } catch (error) { return sendRuntimeError(reply, error); }
  });

  app.post<{ Params: { id: string; entryId: string } }>("/api/sessions/:id/branches/:entryId/regenerate", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      if (!dependencies.chatService) return sendApiError(reply, 503, "REQUEST_FAILED", "会话树服务尚未就绪");
      return reply.code(202).send(await dependencies.chatService.regenerate(request.params.id, request.params.entryId));
    } catch (error) { return sendRuntimeError(reply, error); }
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/sessions/:id/events", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    const afterEventId = readAfterEventId(request.query.after, request.headers["last-event-id"]);
    if (afterEventId === "invalid") {
      return sendApiError(reply, 400, "INVALID_EVENT_CURSOR", "事件游标必须是非负整数");
    }
    if (dependencies.chatService) {
      let subscription: Awaited<ReturnType<ChatApplicationService["subscribe"]>>;
      try {
        subscription = await dependencies.chatService.subscribe(request.params.id, afterEventId);
      } catch (error) {
        return sendRuntimeError(reply, error);
      }
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.flushHeaders();
      const connection = new SseConnection(reply.raw);
      // 队列保护或 Runtime 换代必须主动关闭 socket，才能打断可能无限等待的 drain。
      void subscription.terminated.then((failure) => {
        if (failure) connection.terminate();
        else connection.close();
      });
      const heartbeat = setInterval(() => { void connection.heartbeat(); }, dependencies.heartbeatMs ?? 15_000);
      heartbeat.unref();
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(heartbeat);
        subscription.close();
        connection.close();
      };
      void connection.terminated.then(cleanup);
      request.raw.once("close", cleanup);
      reply.raw.once("close", cleanup);
      void (async () => {
        try {
          for await (const event of subscription.events) await connection.send(event);
        } catch (error) {
          if (!(error instanceof DomainError && ["CLIENT_TOO_SLOW", "RUNTIME_GENERATION_RETIRED"].includes(error.code))) {
            request.log.warn({ err: error, sessionId: request.params.id }, "Session SSE 输出中断");
          }
        } finally {
          cleanup();
          connection.close();
        }
      })();
      return;
    }

    let acquired: Awaited<ReturnType<typeof acquireRuntimeForSession>> | undefined;
    try {
      acquired = await acquireRuntimeForSession(dependencies, request.params.id);
      await acquired.runtime.openSession(request.params.id);
    } catch (error) {
      acquired?.release();
      return sendRuntimeError(reply, error);
    }
    if (!acquired) throw new Error("Session Runtime 获取失败");

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.flushHeaders();

    const writeEvent = (event: ChatEvent) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    const unsubscribe = acquired.runtime.subscribe(request.params.id, afterEventId, writeEvent);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(": heartbeat\n\n");
      }
    }, dependencies.heartbeatMs ?? 15_000);
    heartbeat.unref();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      acquired.release();
    };
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
  });
}

async function acquireRuntimeForSession(
  dependencies: ChatRouteDependencies,
  sessionId: string,
): Promise<{ runtime: PiRuntimeGateway; agentId: string; release(): void }> {
  if (!dependencies.runtimeSupervisor) {
    if (!dependencies.runtime) throw new Error("Session Runtime 尚未配置");
    return { runtime: dependencies.runtime, agentId: "default", release: () => undefined };
  }
  const agentId = await resolveSessionAgentId(sessionId, dependencies.sessionMetadata);
  const lease = await dependencies.runtimeSupervisor.acquire(agentId);
  return { runtime: lease.runtime, agentId, release: lease.release };
}

function readAfterEventId(
  queryValue: string | undefined,
  headerValue: string | string[] | undefined,
): number | undefined | "invalid" {
  const value = queryValue ?? (Array.isArray(headerValue) ? headerValue[0] : headerValue);
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    return "invalid";
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function readFilePaths(value: unknown): string[] | "invalid" {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 5 || value.some((path) => typeof path !== "string" || !path)) {
    return "invalid";
  }
  const unique = [...new Set(value as string[])];
  return unique.length === value.length ? unique : "invalid";
}

/**
 * 仅识别消息开头的斜杠命令，普通文本中的斜杠不会触发 SDK 命令校验。
 */
function readCommandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const value = text.slice(1).trim().split(/\s/u, 1)[0];
  return value || undefined;
}

async function resolveFiles(
  service: WorkspaceFileService | undefined,
  agentId: string,
  filePaths: string[],
): Promise<WorkspaceFileInfo[] | undefined> {
  if (filePaths.length === 0) {
    return [];
  }
  if (!service) {
    return undefined;
  }
  try {
    const files = await Promise.all(filePaths.map((path) => service.resolve(agentId, path)));
    return files.every((file): file is WorkspaceFileInfo => file !== undefined) ? files : undefined;
  } catch {
    return undefined;
  }
}

/** 兼容未初始化时的延迟 Runtime 路径；初始化后的生产请求由 ChatApplicationService 处理。 */
function buildPrompt(text: string, references: AgentReference[]): string {
  const protocol = compileAgentReferences(references);
  return protocol ? `${text}${text ? "\n\n" : ""}${protocol}` : text;
}

function mergeReferences(references: AgentReference[], files: WorkspaceFileInfo[]): AgentReference[] {
  const paths = new Set(references.flatMap((reference) => reference.type === "file" ? [reference.path] : []));
  return [
    ...references,
    ...files.flatMap((file) => {
      if (paths.has(file.path)) return [];
      paths.add(file.path);
      return [{ type: "file" as const, path: file.path, kind: "file" as const, name: file.name }];
    }),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
