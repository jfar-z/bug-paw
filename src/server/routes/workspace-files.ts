import type { FastifyInstance } from "fastify";
import type { WorkspaceFileManager } from "../workspace-files";
import { WorkspaceFileManagerError } from "../workspace-files";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface WorkspaceFileRouteDependencies {
  authService: AuthService;
  manager: WorkspaceFileManager;
  runAgentMutation?<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
}

interface AgentParams {
  agentId: string;
}

interface DirectoryQuery {
  directory?: string;
  includeHidden?: string;
}

interface SearchQuery {
  query?: string;
  includeHidden?: string;
}

interface TextQuery {
  path?: string;
}

type UpdateEntryBody =
  | { operation: "rename"; path?: string; name?: string }
  | { operation: "move"; path?: string; targetDirectory?: string; createTargetDirectory?: boolean };

interface DeleteEntriesBody {
  paths?: string[];
}

interface CreateDirectoryBody {
  directory?: string;
  name?: string;
}

/**
 * 注册受 Agent 工作目录安全边界保护的文件浏览与管理接口。
 */
export function registerWorkspaceFileRoutes(app: FastifyInstance, dependencies: WorkspaceFileRouteDependencies): void {
  app.get<{ Params: AgentParams; Querystring: DirectoryQuery }>("/api/agents/:agentId/workspace/entries", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return { entries: await dependencies.manager.list(request.params.agentId, request.query.directory ?? "", request.query.includeHidden === "true") };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{ Params: AgentParams; Querystring: SearchQuery }>("/api/agents/:agentId/workspace/search", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.query?.trim()) return sendApiError(reply, 400, "INVALID_PATH", "请输入文件名关键字");
    try {
      return { entries: await dependencies.manager.search(request.params.agentId, request.query.query, request.query.includeHidden === "true") };
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.get<{ Params: AgentParams; Querystring: TextQuery }>("/api/agents/:agentId/workspace/text", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.path) return sendApiError(reply, 400, "INVALID_PATH", "请提供文件路径");
    try {
      return await dependencies.manager.readText(request.params.agentId, request.query.path);
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.post<{ Params: AgentParams; Body: CreateDirectoryBody }>("/api/agents/:agentId/workspace/directories", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.body?.name) return sendApiError(reply, 400, "INVALID_PATH", "请提供目录名称");
    try {
      return reply.code(201).send(await runAgentMutation(
        dependencies,
        request.params.agentId,
        () => dependencies.manager.createDirectory(request.params.agentId, request.body.directory ?? "", request.body.name!),
      ));
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.post<{ Params: AgentParams; Querystring: DirectoryQuery }>("/api/agents/:agentId/workspace/uploads", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传文件");
    try {
      const entries = await runAgentMutation(dependencies, request.params.agentId, async () => {
        const uploads = async function* () {
          for await (const part of request.files()) {
            yield { filename: part.filename, mediaType: part.mimetype, stream: part.file };
          }
        };
        return dependencies.manager.saveUploads(request.params.agentId, request.query.directory ?? "", uploads());
      });
      if (!entries.length) return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个文件");
      return reply.code(201).send({ entries });
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.patch<{ Params: AgentParams; Body: UpdateEntryBody }>("/api/agents/:agentId/workspace/entries", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = request.body;
    if (!body?.path) return sendApiError(reply, 400, "INVALID_PATH", "请提供文件路径");
    try {
      if (body.operation === "rename" && body.name) return await runAgentMutation(
        dependencies,
        request.params.agentId,
        () => dependencies.manager.rename(request.params.agentId, body.path!, body.name!),
      );
      if (body.operation === "move" && body.targetDirectory !== undefined) {
        return await runAgentMutation(
          dependencies,
          request.params.agentId,
          () => dependencies.manager.move(request.params.agentId, body.path!, body.targetDirectory!, body.createTargetDirectory === true),
        );
      }
      return sendApiError(reply, 400, "INVALID_PATH", "文件操作参数无效");
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });

  app.delete<{ Params: AgentParams; Body: DeleteEntriesBody }>("/api/agents/:agentId/workspace/entries", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!Array.isArray(request.body?.paths) || request.body.paths.length === 0) return sendApiError(reply, 400, "INVALID_PATH", "至少选择一个文件或目录");
    try {
      await runAgentMutation(
        dependencies,
        request.params.agentId,
        () => dependencies.manager.remove(request.params.agentId, request.body.paths!),
      );
      return reply.code(204).send();
    } catch (error) {
      return sendWorkspaceError(reply, error);
    }
  });
}

function runAgentMutation<T>(
  dependencies: WorkspaceFileRouteDependencies,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return dependencies.runAgentMutation?.(agentId, operation) ?? operation();
}

/** 将工作区服务错误映射为稳定的 HTTP API 协议。 */
function sendWorkspaceError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  if (error instanceof WorkspaceFileManagerError) {
    const status = error.code === "NOT_FOUND" ? 404
      : error.code === "CONFLICT" ? 409
      : error.code === "TEXT_PREVIEW_UNAVAILABLE" ? 422
      : error.code === "WORKSPACE_SCAN_LIMIT" ? 413
      : 400;
    return sendApiError(reply, status, error.code, error.message);
  }
  if (error instanceof Error && error.message === "Agent 不存在") return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
  throw error;
}
