import type { FastifyInstance } from "fastify";
import type { ComposerCatalogService } from "../composer-catalog";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

/** 注册输入框读取一次后缓存的引用与安全命令目录接口。 */
export function registerComposerCatalogRoutes(
  app: FastifyInstance,
  dependencies: { authService: AuthService; catalog: ComposerCatalogService },
): void {
  app.get<{ Params: { agentId: string } }>("/api/agents/:agentId/composer-catalog", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const catalog = await dependencies.catalog.list(request.params.agentId);
    return catalog ? reply.send(catalog) : sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
  });
}
