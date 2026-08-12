import type { FastifyInstance } from "fastify";

import type { BrowserAutomationConfig, BrowserAutomationConfigDocument, BrowserDeploymentStatus } from "../../shared/browser-automation-contracts";
import type { BrowserAuditEvent } from "../browser-automation/browser-audit-repository";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface BrowserAutomationRouteDependencies {
  authService: AuthService;
  configs: {
    read(): Promise<BrowserAutomationConfigDocument>;
    update(config: BrowserAutomationConfig, revision: string): Promise<BrowserAutomationConfigDocument>;
  };
  deploymentAvailable: boolean;
  status(): Promise<Omit<BrowserDeploymentStatus, "available">>;
  test(): Promise<{ ok: boolean; message: string }>;
  audit: { list(limit: number): BrowserAuditEvent[] };
  onConfigUpdated(previous: BrowserAutomationConfig, current: BrowserAutomationConfig): Promise<void>;
}

/** 注册浏览器能力配置、状态、自检和最小审计接口。 */
export function registerBrowserAutomationRoutes(app: FastifyInstance, dependencies: BrowserAutomationRouteDependencies): void {
  app.get("/api/capabilities/browser", async (request, reply) => {
    if (!await requireAuthentication(request, reply, dependencies.authService)) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await settingsDocument(dependencies));
  });

  app.patch("/api/capabilities/browser", async (request, reply) => {
    if (!await requireAuthentication(request, reply, dependencies.authService)) return;
    reply.header("Cache-Control", "no-store");
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || !isRecord(body.config)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "浏览器能力配置格式无效");
    }
    try {
      const previous = await dependencies.configs.read();
      const current = await dependencies.configs.update(body.config as unknown as BrowserAutomationConfig, body.revision);
      await dependencies.onConfigUpdated(previous.config, current.config);
      return reply.send({ ...current, deployment: { available: dependencies.deploymentAvailable, ...await dependencies.status() } });
    } catch (error) {
      if (error instanceof Error && error.name === "VersionConflictError") return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
      return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "浏览器能力配置无效");
    }
  });

  app.post("/api/capabilities/browser/test", async (request, reply) => {
    if (!await requireAuthentication(request, reply, dependencies.authService)) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(dependencies.deploymentAvailable
      ? await dependencies.test()
      : { ok: false, message: "当前部署未包含浏览器执行组件" });
  });

  app.get("/api/capabilities/browser/audit", async (request, reply) => {
    if (!await requireAuthentication(request, reply, dependencies.authService)) return;
    reply.header("Cache-Control", "no-store");
    const query = request.query as { limit?: string };
    const limit = query.limit === undefined ? 30 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return sendApiError(reply, 400, "VALIDATION_FAILED", "审计数量必须在 1 到 100 之间");
    return reply.send({ events: dependencies.audit.list(limit).map(({ agentId: _agentId, sessionId: _sessionId, runId: _runId, ...event }) => event) });
  });
}

/** 合并配置与无敏感信息的部署状态。 */
async function settingsDocument(dependencies: BrowserAutomationRouteDependencies) {
  return {
    ...await dependencies.configs.read(),
    deployment: { available: dependencies.deploymentAvailable, ...await dependencies.status() },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
