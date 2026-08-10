import { createReadStream } from "node:fs";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UploadLimits, WorkspaceFileInfo, WorkspaceFileService } from "../attachments";
import { DEFAULT_UPLOAD_LIMITS, toPublicWorkspaceFile } from "../attachments";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface AttachmentRouteDependencies {
  authService: AuthService;
  files: WorkspaceFileService;
  limits?: UploadLimits;
  runAgentMutation?<T>(agentId: string, operation: () => Promise<T>): Promise<T>;
}

interface FileParams {
  agentId: string;
  "*": string;
}

interface FileQuery {
  download?: string;
}

/**
 * 注册附件上传和 cwd 内通用文件读取接口。
 */
export function registerAttachmentRoutes(app: FastifyInstance, dependencies: AttachmentRouteDependencies): void {
  const limits = dependencies.limits ?? DEFAULT_UPLOAD_LIMITS;

  app.post<{ Params: { agentId: string } }>("/api/agents/:agentId/attachments", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) {
      return;
    }
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传附件");
    }

    const savedPaths: string[] = [];
    try {
      return await runAgentMutation(dependencies, request.params.agentId, async () => {
        const files = [];
        for await (const part of request.files({ limits: { files: limits.maxFiles, fileSize: limits.maxFileSize } })) {
          const saved = await dependencies.files.saveUpload(
            request.params.agentId,
            part.filename,
            part.mimetype,
            part.file,
          );
          savedPaths.push(saved.path);
          files.push(toPublicWorkspaceFile(saved));
        }
        if (files.length === 0) {
          return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个附件");
        }
        return reply.code(201).send({ files });
      });
    } catch (error) {
      await Promise.all(savedPaths.map((path) => dependencies.files.remove(request.params.agentId, path)));
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
        return sendApiError(reply, 413, "ATTACHMENT_TOO_LARGE", `单个附件不能超过 ${limits.maxFileSize} 字节`);
      }
      if (error instanceof app.multipartErrors.FilesLimitError) {
        return sendApiError(reply, 413, "TOO_MANY_ATTACHMENTS", `单次最多上传 ${limits.maxFiles} 个附件`);
      }
      if (isAgentNotFound(error)) {
        return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
      }
      throw error;
    }
  });

  app.route<{ Params: FileParams; Querystring: FileQuery }>({
    method: ["GET", "HEAD"],
    url: "/api/agents/:agentId/files/*",
    handler: async (request, reply) => {
      if (!(await requireAuthentication(request, reply, dependencies.authService))) {
        return;
      }
      let file: WorkspaceFileInfo | undefined;
      try {
        file = await dependencies.files.resolve(request.params.agentId, request.params["*"]);
      } catch (error) {
        if (isAgentNotFound(error)) {
          return sendApiError(reply, 404, "AGENT_NOT_FOUND", "Agent 不存在");
        }
        return sendApiError(reply, 400, "INVALID_FILE_PATH", "工作目录文件路径无效");
      }
      if (!file) {
        return sendApiError(reply, 404, "FILE_NOT_FOUND", "工作目录文件不存在");
      }
      return sendFile(request, reply, file, request.query.download === "1");
    },
  });
}

function runAgentMutation<T>(
  dependencies: AttachmentRouteDependencies,
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return dependencies.runAgentMutation?.(agentId, operation) ?? operation();
}

/** 判断底层工作目录服务是否因 Agent 不存在而失败。 */
function isAgentNotFound(error: unknown): boolean {
  return error instanceof Error && error.message === "Agent 不存在";
}

async function sendFile(request: FastifyRequest, reply: FastifyReply, file: WorkspaceFileInfo, download: boolean) {
  reply.header("Accept-Ranges", "bytes");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Last-Modified", new Date(file.modifiedAt).toUTCString());
  reply.type(file.mediaType);
  if (download) {
    reply.header("Content-Disposition", attachmentDisposition(file.name));
  }
  if (request.method === "HEAD") {
    reply.header("Content-Length", String(file.size));
    return reply.send();
  }

  const range = download ? undefined : parseRange(request.headers.range, file.size);
  if (range === "invalid") {
    reply.header("Content-Range", `bytes */${file.size}`);
    return reply.code(416).send();
  }
  if (range) {
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
    reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.code(206).send(createReadStream(file.absolutePath, range));
  }
  reply.header("Content-Length", String(file.size));
  return reply.send(createReadStream(file.absolutePath));
}

function parseRange(value: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || size <= 0) {
    return "invalid";
  }
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[2] && match[1] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return "invalid";
  }
  end = Math.min(end, size - 1);
  return { start, end };
}

function attachmentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii || "file"}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
