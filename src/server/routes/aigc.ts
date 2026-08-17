import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  AigcInterfaceInput,
  AigcPublicFileSummary,
  AigcRunRequest,
  AigcWorkflowCreateInput,
  AigcWorkflowUpdateInput,
} from "../../shared/aigc-contracts";
import type { AigcAssetService } from "../aigc/aigc-asset-service";
import type { AigcInterfaceService } from "../aigc/aigc-interface-service";
import type { AigcPublicFileService } from "../aigc/aigc-public-file-service";
import type { AigcTaskService } from "../aigc/aigc-task-service";
import type { AigcWorkflowService } from "../aigc/aigc-workflow-service";
import { VersionConflictError } from "../configuration/versioned-json-store";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface AigcRouteDependencies {
  authService: AuthService;
  workflows: AigcWorkflowService;
  interfaces: AigcInterfaceService;
  tasks: AigcTaskService;
  assets: AigcAssetService;
  publicFiles: AigcPublicFileService;
}

/** 注册 AIGC 工作台的工作流、接口、任务与资产接口。 */
export function registerAigcRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  registerWorkflowRoutes(app, dependencies);
  registerInterfaceRoutes(app, dependencies);
  registerTaskRoutes(app, dependencies);
  registerAssetRoutes(app, dependencies);
  registerPublicFileRoutes(app, dependencies);
}

function registerWorkflowRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/workflows", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await dependencies.workflows.list());
  });

  app.post("/api/aigc/workflows", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.name !== "string" || typeof body.fileName !== "string" || !Array.isArray(body.inputMappings) || !Array.isArray(body.outputMappings)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "工作流导入格式无效");
    }
    try {
      const created = await dependencies.workflows.create(body as unknown as AigcWorkflowCreateInput);
      return reply.code(201).send(created.workflow);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/workflows/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await dependencies.workflows.get(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/aigc/workflows/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || typeof body.name !== "string" || !Array.isArray(body.inputMappings) || !Array.isArray(body.outputMappings)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "工作流更新格式无效");
    }
    try {
      const updated = await dependencies.workflows.update(request.params.id, body as unknown as AigcWorkflowUpdateInput, body.revision);
      return reply.send(updated.workflow);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/workflows/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    try {
      if (await dependencies.interfaces.isWorkflowInUse(request.params.id)) {
        return sendApiError(reply, 409, "VALIDATION_FAILED", "该工作流仍被 AIGC 接口引用");
      }
      await dependencies.workflows.remove(request.params.id, body.revision);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });
}

function registerInterfaceRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/interfaces", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await dependencies.interfaces.list());
  });

  app.post("/api/aigc/interfaces", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body) return sendApiError(reply, 400, "VALIDATION_FAILED", "接口配置格式无效");
    try {
      const created = await dependencies.interfaces.create(body as unknown as AigcInterfaceInput);
      return reply.code(201).send(created.item);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/interfaces/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const item = await dependencies.interfaces.get(request.params.id);
    if (!item) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 接口不存在");
    return reply.send(item);
  });

  app.patch<{ Params: { id: string } }>("/api/aigc/interfaces/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "接口更新格式无效");
    try {
      const updated = await dependencies.interfaces.update(request.params.id, body as unknown as AigcInterfaceInput, body.revision);
      return reply.send(updated.item);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/interfaces/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    try {
      await dependencies.interfaces.remove(request.params.id, body.revision);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });
}

function registerTaskRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await dependencies.tasks.list());
  });

  app.post("/api/aigc/tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.interfaceId !== "string" || !isRecord(body.inputs)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "任务运行参数格式无效");
    }
    try {
      const task = await dependencies.tasks.createRun(body as unknown as AigcRunRequest);
      return reply.code(202).send(task);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/tasks/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const task = await dependencies.tasks.get(request.params.id);
    if (!task) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 任务不存在");
    return reply.send(task);
  });

  app.post<{ Params: { id: string } }>("/api/aigc/tasks/:id/cancel", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await dependencies.tasks.cancel(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/aigc/tasks/:id/retry", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await dependencies.tasks.retry(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string; assetId: string }; Querystring: { download?: string } }>("/api/aigc/tasks/:id/assets/:assetId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const task = await dependencies.tasks.get(request.params.id);
    if (!task) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 任务不存在");
    const asset = task.assets.find((candidate) => candidate.id === request.params.assetId);
    if (!asset) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 产物不存在");
    const path = await dependencies.assets.resolveOutputPath(task.id, asset.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 产物不存在");
    return sendAssetFile(reply, path, asset.name, asset.mediaType, request.query.download === "1");
  });
}

function registerAssetRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.post("/api/aigc/inputs", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传 AIGC 入参");
    try {
      const part = await request.file({ limits: { files: 1, fileSize: 200 * 1024 * 1024 } });
      if (!part) return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个 AIGC 入参文件");
      const saved = await dependencies.assets.saveInput(part.file, part.filename, part.mimetype);
      return reply.code(201).send({ asset: saved });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return sendApiError(reply, 413, "VALIDATION_FAILED", "AIGC 入参不能超过 200 MiB");
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/inputs/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const path = await dependencies.assets.resolveInputPath(request.params.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 入参不存在");
    return sendAssetFile(reply, path, request.params.id, "application/octet-stream", false);
  });
}

/** 注册公网可直接访问的 AIGC 公共文件上传、列表与下载接口。 */
function registerPublicFileRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/public-files", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const files = await dependencies.publicFiles.list();
    return reply.send({
      files: files.map((file) => toPublicFileSummary(file, publicFileUrl(request, file.id))),
    });
  });

  app.post("/api/aigc/public-files", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传 AIGC 公共文件");
    try {
      const part = await request.file({ limits: { files: 1, fileSize: 200 * 1024 * 1024 } });
      if (!part) return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个 AIGC 公共文件");
      const file = await dependencies.publicFiles.save(part.file, part.filename, part.mimetype);
      return reply.code(201).send({ file: toPublicFileSummary(file, publicFileUrl(request, file.id)) });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return sendApiError(reply, 413, "VALIDATION_FAILED", "AIGC 公共文件不能超过 200 MiB");
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/public-files/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!await dependencies.publicFiles.remove(request.params.id)) {
      return sendApiError(reply, 404, "NOT_FOUND", "AIGC 公共文件不存在");
    }
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/aigc-public/files/:id", async (request, reply) => {
    const [path, file] = await Promise.all([
      dependencies.publicFiles.resolvePath(request.params.id),
      dependencies.publicFiles.get(request.params.id),
    ]);
    if (!path || !file) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 公共文件不存在");
    return sendAssetFile(reply, path, file.name, file.mediaType, false);
  });
}

/** 将公共文件记录映射为包含公网 URL 的浏览器摘要。 */
function toPublicFileSummary(file: { id: string; name: string; mediaType: string; size: number; createdAt: string }, url: string): AigcPublicFileSummary {
  return { ...file, url };
}

/** 根据请求 Host 与转发头生成公网可直接访问的文件 URL。 */
function publicFileUrl(request: FastifyRequest, id: string): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const protocol = forwardedProto?.split(",", 1)[0].trim() || request.protocol;
  const host = forwardedHost?.split(",", 1)[0].trim() || request.headers.host || "localhost";
  return `${protocol}://${host}/aigc-public/files/${encodeURIComponent(id)}`;
}

/** 读取单值请求头。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 发送资产文件并固定安全响应头。 */
async function sendAssetFile(reply: Parameters<typeof sendApiError>[0], path: string, name: string, mediaType: string, download: boolean) {
  const fileStat = await stat(path);
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.type(mediaType);
  if (download) reply.header("Content-Disposition", downloadContentDisposition(name));
  reply.header("Content-Length", String(fileStat.size));
  return reply.send(createReadStream(path));
}

/** 兼容中文产物名，并阻止文件名向响应头注入控制字符。 */
function downloadContentDisposition(name: string): string {
  const normalized = name.replace(/[\r\n]/gu, "").trim() || "download";
  const asciiFallback = normalized.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_") || "download";
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function sendAigcError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  const message = error instanceof Error ? error.message : "AIGC 请求无效";
  if (message.includes("不存在")) return sendApiError(reply, 404, "NOT_FOUND", message);
  if (message.includes("未启用") || message.includes("已取消") || message.includes("引用")) return sendApiError(reply, 409, "VALIDATION_FAILED", message);
  return sendApiError(reply, 400, "VALIDATION_FAILED", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
