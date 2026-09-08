import type { FastifyInstance } from "fastify";
import type { DataFileService } from "../data-files";
import { DataFileError } from "../data-files";
import type { AuthService } from "./auth";
import { sendResolvedFile } from "./attachments";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface DataFileRouteDependencies {
  authService: AuthService;
  files: DataFileService;
}

interface DataFileParams {
  agentId: string;
}

interface DataFileQuery {
  path?: string;
  download?: string;
}

/** 注册登录后可访问整个挂载 `/data` 的只读文件接口。 */
export function registerDataFileRoutes(app: FastifyInstance, dependencies: DataFileRouteDependencies): void {
  app.route<{ Params: DataFileParams; Querystring: DataFileQuery }>({
    method: ["GET", "HEAD"],
    url: "/api/agents/:agentId/data-files",
    handler: async (request, reply) => {
      if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
      if (!request.query.path) return sendApiError(reply, 400, "INVALID_PATH", "请提供文件路径");
      try {
        const file = await dependencies.files.resolve(request.params.agentId, request.query.path);
        return sendResolvedFile(request, reply, file, request.query.download === "1");
      } catch (error) {
        return sendDataFileError(reply, error);
      }
    },
  });

  app.get<{ Params: DataFileParams; Querystring: DataFileQuery }>("/api/agents/:agentId/data-files/text", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.path) return sendApiError(reply, 400, "INVALID_PATH", "请提供文件路径");
    try {
      return await dependencies.files.readText(request.params.agentId, request.query.path);
    } catch (error) {
      return sendDataFileError(reply, error);
    }
  });
}

function sendDataFileError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  if (error instanceof DataFileError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "TEXT_PREVIEW_UNAVAILABLE" ? 422 : 400;
    return sendApiError(reply, status, error.code, error.message);
  }
  if (error instanceof Error && error.message === "Agent 不存在") return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
  throw error;
}
