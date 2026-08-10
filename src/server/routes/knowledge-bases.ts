import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";

import type { CreateKnowledgeBaseRequest, KnowledgeBaseService, UpdateKnowledgeBaseRequest } from "../knowledge-base/knowledge-base-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";
import { toSafePublicMessage } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";

const SUPPORTED_MEDIA_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

/** 注册知识库及其资料管理接口。 */
export function registerKnowledgeBaseRoutes(app: FastifyInstance, dependencies: { authService: AuthService; service: KnowledgeBaseService }): void {
  app.get("/api/knowledge-bases", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send({ knowledgeBases: await dependencies.service.listBases() });
  });

  app.post("/api/knowledge-bases", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const input = readBaseInput(request.body);
    if (!input || typeof input.name !== "string") return sendApiError(reply, 400, "INVALID_KNOWLEDGE_BASE", "知识库名称或绑定 Agent 参数无效");
    try {
      return reply.code(201).send(await dependencies.service.createBase({
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.agentIds !== undefined ? { agentIds: input.agentIds } : {}),
      }));
    } catch (error) {
      return sendKnowledgeError(reply, error);
    }
  });

  app.get<{ Params: { knowledgeBaseId: string } }>("/api/knowledge-bases/:knowledgeBaseId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const base = await dependencies.service.getBase(request.params.knowledgeBaseId);
    return base ? reply.send(base) : sendApiError(reply, 404, "KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在");
  });

  app.patch<{ Params: { knowledgeBaseId: string } }>("/api/knowledge-bases/:knowledgeBaseId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const input = readBaseInput(request.body, true);
    if (!input) return sendApiError(reply, 400, "INVALID_KNOWLEDGE_BASE", "知识库参数无效");
    try {
      const base = await dependencies.service.updateBase(request.params.knowledgeBaseId, input);
      return base ? reply.send(base) : sendApiError(reply, 404, "KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在");
    } catch (error) {
      return sendKnowledgeError(reply, error);
    }
  });

  app.delete<{ Params: { knowledgeBaseId: string } }>("/api/knowledge-bases/:knowledgeBaseId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const removed = await dependencies.service.removeBase(request.params.knowledgeBaseId);
      return removed ? reply.code(204).send() : sendApiError(reply, 404, "KNOWLEDGE_BASE_NOT_FOUND", "知识库不存在");
    } catch (error) {
      return sendKnowledgeError(reply, error);
    }
  });

  app.post<{ Params: { knowledgeBaseId: string } }>("/api/knowledge-bases/:knowledgeBaseId/documents", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传资料");
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.raw.once("aborted", abort);
    async function* uploads() {
      for await (const part of request.files({ limits: { files: SYSTEM_LIMITS.knowledgeUploadFiles, fileSize: 20 * 1024 * 1024 } })) {
        if (!SUPPORTED_MEDIA_TYPES.has(part.mimetype)) {
          throw new UnsupportedKnowledgeFileError();
        }
        yield { name: part.filename, mediaType: part.mimetype, stream: part.file };
      }
    }
    try {
      return reply.code(201).send({ documents: await dependencies.service.uploadDocumentStreams(request.params.knowledgeBaseId, uploads(), controller.signal) });
    } catch (error) {
      if (error instanceof UnsupportedKnowledgeFileError) return sendApiError(reply, 415, "UNSUPPORTED_KNOWLEDGE_FILE", "仅支持 TXT、Markdown、PDF 与 DOCX 文件");
      if (error instanceof Error && "code" in error && error.code === "KNOWLEDGE_UPLOAD_LIMIT") return sendApiError(reply, 413, "KNOWLEDGE_FILE_TOO_LARGE", "单次上传资料总量不能超过 50 MB");
      if (error instanceof app.multipartErrors.RequestFileTooLargeError || error instanceof app.multipartErrors.FilesLimitError) {
        return sendApiError(reply, 413, "KNOWLEDGE_FILE_TOO_LARGE", "单个资料不能超过 20 MB，单次最多上传 10 个文件");
      }
      return sendKnowledgeError(reply, error);
    } finally { request.raw.off("aborted", abort); }
  });

  app.get<{ Params: { knowledgeBaseId: string; documentId: string } }>("/api/knowledge-bases/:knowledgeBaseId/documents/:documentId/source", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const source = await dependencies.service.getDocumentSource(request.params.knowledgeBaseId, request.params.documentId);
      if (!source) return sendApiError(reply, 404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "资料不存在");
      const disposition = source.mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ? "attachment" : "inline";
      return reply
        .type(source.mediaType)
        .header("content-length", source.size)
        .header("content-disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(source.name)}`)
        .send(createReadStream(source.path));
    } catch (error) {
      return sendKnowledgeError(reply, error);
    }
  });

  app.get<{ Params: { knowledgeBaseId: string; documentId: string } }>("/api/knowledge-bases/:knowledgeBaseId/documents/:documentId/chunks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const chunks = await dependencies.service.getDocumentChunks(request.params.knowledgeBaseId, request.params.documentId);
    return chunks ? reply.send({ chunks }) : sendApiError(reply, 404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "资料不存在");
  });

  app.get<{ Params: { knowledgeBaseId: string; documentId: string } }>("/api/knowledge-bases/:knowledgeBaseId/documents/:documentId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const document = await dependencies.service.getDocument(request.params.knowledgeBaseId, request.params.documentId);
    return document ? reply.send(document) : sendApiError(reply, 404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", "资料不存在");
  });

  app.delete<{ Params: { knowledgeBaseId: string; documentId: string } }>("/api/knowledge-bases/:knowledgeBaseId/documents/:documentId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      await dependencies.service.removeDocument(request.params.knowledgeBaseId, request.params.documentId);
      return reply.code(204).send();
    } catch (error) {
      return sendKnowledgeError(reply, error);
    }
  });

  app.post<{ Params: { knowledgeBaseId: string } }>("/api/knowledge-bases/:knowledgeBaseId/search", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : {};
    if (typeof body.query !== "string") return sendApiError(reply, 400, "INVALID_KNOWLEDGE_QUERY", "请输入检索关键词");
    try {
      const limit = typeof body.limit === "number" ? body.limit : undefined;
      return reply.send({ results: await dependencies.service.searchBase(request.params.knowledgeBaseId, body.query, limit) });
    } catch (error) {
      return sendKnowledgeError(reply, error);
    }
  });
}

/** 单次知识资料上传总量超过服务端预算。 */
class UnsupportedKnowledgeFileError extends Error {}

/** 读取创建或更新知识库的 JSON 请求。 */
function readBaseInput(value: unknown, partial = false): CreateKnowledgeBaseRequest | UpdateKnowledgeBaseRequest | undefined {
  if (!isRecord(value)) return undefined;
  if (!partial && (typeof value.name !== "string" || !value.name.trim())) return undefined;
  if (value.name !== undefined && typeof value.name !== "string") return undefined;
  if (value.description !== undefined && typeof value.description !== "string") return undefined;
  if (value.agentIds !== undefined && (!Array.isArray(value.agentIds) || value.agentIds.some((agentId) => typeof agentId !== "string"))) return undefined;
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(Array.isArray(value.agentIds) ? { agentIds: value.agentIds as string[] } : {}),
  };
}

/** 将领域服务错误映射为稳定的 HTTP 错误协议。 */
function sendKnowledgeError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  const message = toSafePublicMessage(error, "知识库操作失败");
  if (message === "知识库不存在") return sendApiError(reply, 404, "KNOWLEDGE_BASE_NOT_FOUND", message);
  if (message === "资料不存在") return sendApiError(reply, 404, "KNOWLEDGE_DOCUMENT_NOT_FOUND", message);
  return sendApiError(reply, 400, "INVALID_KNOWLEDGE_REQUEST", message);
}

/** 判断请求体是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
