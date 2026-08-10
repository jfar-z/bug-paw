import type { FastifyInstance } from "fastify";
import type { AgentStore } from "../agents/agent-store";
import type { DataPaths } from "../paths";
import { createPackageInstallAction, createPackageRemoveAction, ResourceService, ResourceTaskManager, type ConfigurationTaskEvent } from "../resources/resource-service";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";
import { SseConnection } from "../http/sse-connection";
import { SYSTEM_LIMITS } from "../core/limits";

interface ResourceRouteDependencies {
  authService: AuthService; paths: DataPaths; agents: AgentStore; tasks: ResourceTaskManager;
  installAction?: typeof createPackageInstallAction;
  removeAction?: typeof createPackageRemoveAction;
  runAgentMutation?<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * 注册资源目录、内容、原生启停和安装任务 SSE 接口。
 */
export function registerResourceRoutes(app: FastifyInstance, dependencies: ResourceRouteDependencies): void {
  app.get<{ Querystring: { agentId?: string } }>("/api/resources", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const service = await serviceFor(request.query.agentId, dependencies);
    return service ? reply.send(await service.catalog()) : sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
  });
  app.get<{ Querystring: { agentId?: string; id?: string } }>("/api/resources/content", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.id) return sendApiError(reply, 400, "RESOURCE_ID_REQUIRED", "缺少资源 ID");
    const service = await serviceFor(request.query.agentId, dependencies);
    if (!service) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    try { return reply.send({ content: await service.readContent(request.query.id) }); }
    catch (error) { return sendApiError(reply, 404, "RESOURCE_NOT_FOUND", error instanceof Error ? error.message : "资源不存在"); }
  });
  app.patch<{ Params: { id: string } }>("/api/resources/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (!(["enabled", "disabled", "inherit"] as unknown[]).includes(body.mode) || !(["global", "agent"] as unknown[]).includes(body.target)) return sendApiError(reply, 400, "INVALID_RESOURCE_MODE", "资源状态参数无效");
    const agentId = typeof body.agentId === "string" ? body.agentId : undefined;
    const service = await serviceFor(agentId, dependencies);
    if (!service) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    const operation = () => service.setMode(request.params.id, body.mode as "enabled" | "disabled" | "inherit", body.target as "global" | "agent");
    const catalog = body.target === "agent" && agentId
      ? await runAgentMutation(dependencies, agentId, operation)
      : await operation();
    return reply.send(catalog);
  });
  app.post("/api/resources/install", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (body.confirmed !== true || typeof body.source !== "string" || !body.source.trim()) return sendApiError(reply, 400, "INSTALL_CONFIRMATION_REQUIRED", "安装资源前必须确认来源和权限");
    const local = body.scope === "agent";
    const agent = local && typeof body.agentId === "string" ? await dependencies.agents.get(body.agentId) : undefined;
    if (local && !agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    const actionFactory = dependencies.installAction ?? createPackageInstallAction;
    const action = actionFactory({ agentDir: dependencies.paths.piDir, cwd: agent?.profile.cwd ?? dependencies.paths.workspaceDir, source: body.source, local });
    const guardedAction = local && agent
      ? (log: (line: string) => void) => runAgentMutation(dependencies, agent.profile.id, () => action(log))
      : action;
    const taskId = dependencies.tasks.start(`安装 ${body.source}`, guardedAction);
    return reply.code(202).send({ taskId });
  });
  app.post("/api/resources/remove", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (body.confirmed !== true || typeof body.source !== "string" || !body.source.trim()) return sendApiError(reply, 400, "REMOVE_CONFIRMATION_REQUIRED", "卸载资源前必须明确确认");
    const source = body.source;
    const local = body.scope === "agent";
    const agent = local && typeof body.agentId === "string" ? await dependencies.agents.get(body.agentId) : undefined;
    if (local && !agent) return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
    if (!local) {
      for (const document of await dependencies.agents.list()) {
        const projectPackages = SettingsManager.create(document.profile.cwd, dependencies.paths.piDir).getProjectSettings().packages ?? [];
        if (projectPackages.some((item) => (typeof item === "string" ? item : item.source) === source)) return sendApiError(reply, 409, "PACKAGE_IN_USE", `Package 仍被 Agent ${document.profile.name} 引用`);
      }
    }
    const factory = dependencies.removeAction ?? createPackageRemoveAction;
    const taskId = dependencies.tasks.start(
      `卸载 ${source}`,
      local && agent
        ? (log) => runAgentMutation(dependencies, agent.profile.id, () => factory({ agentDir: dependencies.paths.piDir, cwd: agent.profile.cwd, source, local })(log))
        : factory({ agentDir: dependencies.paths.piDir, cwd: dependencies.paths.workspaceDir, source, local }),
    );
    return reply.code(202).send({ taskId });
  });
  app.get<{ Params: { id: string } }>("/api/configuration/tasks/:id/events", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const stored = dependencies.tasks.history(request.params.id);
    if (!stored) return sendApiError(reply, 404, "TASK_NOT_FOUND", "任务不存在");
    const history = [...stored];
    const terminal = history.some((event) => event.type === "completed" || event.type === "failed");
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", Connection: "keep-alive" });
    reply.raw.flushHeaders();
    const connection = new SseConnection(reply.raw);
    let queuedEntries = 0;
    let queuedBytes = 0;
    let tail = Promise.resolve();
    let unsubscribe: () => void = () => undefined;
    const write = (event: ConfigurationTaskEvent) => {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      queuedEntries += 1;
      queuedBytes += bytes;
      if (queuedEntries > SYSTEM_LIMITS.sseQueueEntries || queuedBytes > SYSTEM_LIMITS.sseQueueBytes) {
        unsubscribe();
        connection.terminate();
        return;
      }
      tail = tail.then(() => connection.sendData(event)).finally(() => {
        queuedEntries -= 1;
        queuedBytes -= bytes;
      });
      if (event.type === "completed" || event.type === "failed") {
        void tail.then(() => { unsubscribe(); connection.close(); });
      }
    };
    if (!terminal) unsubscribe = dependencies.tasks.subscribe(request.params.id, write);
    history.forEach(write);
    if (terminal) void tail.then(() => connection.close());
    const cleanup = () => { unsubscribe(); connection.close(); };
    request.raw.once("close", cleanup);
    reply.raw.once("close", cleanup);
    return;
  });
}

async function serviceFor(agentId: string | undefined, dependencies: ResourceRouteDependencies) {
  if (!agentId) return new ResourceService({ agentDir: dependencies.paths.piDir, cwd: dependencies.paths.workspaceDir });
  const agent = await dependencies.agents.get(agentId);
  return agent ? new ResourceService({ agentDir: dependencies.paths.piDir, cwd: agent.profile.cwd }) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function runAgentMutation<T>(dependencies: ResourceRouteDependencies, agentId: string, operation: () => Promise<T>): Promise<T> {
  return dependencies.runAgentMutation?.(agentId, operation) ?? operation();
}
