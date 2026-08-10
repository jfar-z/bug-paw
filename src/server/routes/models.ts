import type { FastifyInstance } from "fastify";
import type { ModelSummary, PiRuntimeGateway } from "../pi-runtime";
import type { AuthService } from "./auth";
import { requireAuthentication } from "./protected";

interface ModelRouteDependencies {
  authService: AuthService;
  listModels?: () => Promise<ModelSummary[]>;
  runtime?: PiRuntimeGateway;
}

/**
 * 注册可用模型查询接口。
 */
export function registerModelRoutes(app: FastifyInstance, dependencies: ModelRouteDependencies): void {
  app.get("/api/models", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    const listModels = dependencies.listModels ?? dependencies.runtime?.listModels;
    if (!listModels) {
      throw new Error("模型目录尚未就绪");
    }
    return reply.send({ models: await listModels() });
  });
}
