import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";

import type {
  AigcInterfaceInput,
  AigcRunRequest,
  AigcWorkflowCreateInput,
  AigcWorkflowUpdateInput,
} from "../../shared/aigc-contracts";
import type { AigcAssetService } from "../aigc/aigc-asset-service";
import type { AigcInterfaceService } from "../aigc/aigc-interface-service";
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
}

/** 注册 AIGC 工作台的工作流、接口、任务与资产接口。 */
export function registerAigcRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  registerWorkflowRoutes(app, dependencies);
  registerInterfaceRoutes(app, dependencies);
  registerTaskRoutes(app, dependencies);
  registerAssetRoutes(app, dependencies);
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

  app.get<{ Params: { id: string; assetId: string } }>("/api/aigc/tasks/:id/assets/:assetId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const task = await dependencies.tasks.get(request.params.id);
    if (!task) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 任务不存在");
    const asset = task.assets.find((candidate) => candidate.id === request.params.assetId);
    if (!asset) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 产物不存在");
    const path = await dependencies.assets.resolveOutputPath(task.id, asset.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 产物不存在");
    return sendAssetFile(reply, path, asset.name, asset.mediaType, true);
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

/** 发送资产文件并固定安全响应头。 */
async function sendAssetFile(reply: Parameters<typeof sendApiError>[0], path: string, name: string, mediaType: string, download: boolean) {
  const fileStat = await stat(path);
  reply.header("Cache-Control", "no-store");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.type(mediaType);
  if (download) reply.header("Content-Disposition", `attachment; filename="${name.replaceAll('"', "")}"`);
  reply.header("Content-Length", String(fileStat.size));
  return reply.send(createReadStream(path));
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
