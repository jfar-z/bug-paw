import type { FastifyInstance } from "fastify";
import type { DataPaths } from "../paths";
import type { AuthService } from "./auth";

interface StatusRouteDependencies {
  paths: DataPaths;
  authService: AuthService;
}

/**
 * 注册不泄露配置内容的服务状态接口。
 */
export function registerStatusRoutes(app: FastifyInstance, dependencies: StatusRouteDependencies): void {
  app.get("/api/status", async (request, reply) => {
    const initialized = await dependencies.authService.isInitialized();
    const authenticated = initialized ? await dependencies.authService.isAuthenticated(request) : false;
    return reply.send({
      initialized,
      authenticated,
    });
  });
}
