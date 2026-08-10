import type { FastifyInstance } from "fastify";

import type { WebResearchConfig, WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import { EgressProfileRegistry } from "../web-research/egress-profile-registry";
import { VersionConflictError } from "../configuration/versioned-json-store";
import type { WebResearchConfigService } from "../web-research/web-research-config-service";
import type { WebResearchService } from "../web-research/web-research-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface WebResearchRouteDependencies {
  authService: AuthService;
  configs: WebResearchConfigService;
  service: WebResearchService;
  refreshRuntime: () => Promise<unknown>;
  egressProfiles: EgressProfileRegistry;
}

/** 注册能力扩展中的联网搜索配置接口。 */
export function registerWebResearchRoutes(app: FastifyInstance, dependencies: WebResearchRouteDependencies): void {
  app.get("/api/capabilities/web-research", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    return reply.send(await documentWithProfiles(dependencies));
  });
  app.patch("/api/capabilities/web-research", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    const body = request.body as { revision?: unknown; config?: unknown };
    if (typeof body?.revision !== "string" || !isRecord(body.config)) return sendApiError(reply, 400, "VALIDATION_FAILED", "联网搜索配置格式无效");
    try {
      const document = await dependencies.configs.update(body.config as unknown as WebResearchConfig, body.revision);
      await dependencies.refreshRuntime();
      return reply.send({ ...document, egressProfiles: await dependencies.egressProfiles.listSummaries() });
    } catch (error) {
      if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
      return sendApiError(reply, 400, "VALIDATION_FAILED", error instanceof Error ? error.message : "联网搜索配置无效");
    }
  });
  app.post("/api/capabilities/web-research/test", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    reply.header("Cache-Control", "no-store");
    try {
      await dependencies.service.testConnection();
      return reply.send({ ok: true, message: "SearXNG 服务连接正常" });
    } catch {
      return reply.send({ ok: false, message: "无法连接 SearXNG 服务，请检查地址和服务状态" });
    }
  });
}

/** 将部署侧敏感配置投影为配置中心可安全展示的摘要。 */
async function documentWithProfiles(dependencies: WebResearchRouteDependencies): Promise<WebResearchSettingsDocument> {
  return { ...(await dependencies.configs.read()), egressProfiles: await dependencies.egressProfiles.listSummaries() };
}

/** 判断未知输入是否为对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
