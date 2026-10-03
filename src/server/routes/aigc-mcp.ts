import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "../../shared/api/common";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import * as z from "zod/v4";
import { toSafePublicMessage } from "../core/errors";
import { AigcMcpError, MCP_OPERATIONS, type AigcMcpClient, type AigcMcpService, type McpOperation } from "../aigc/aigc-mcp-service";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface Dependencies { authService: AuthService; service: AigcMcpService }

/** 管理端使用登录态；MCP、上传和下载仅接受专用 Bearer 令牌。 */
export function registerAigcMcpRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  app.get("/api/aigc/mcp/clients", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.header("Cache-Control", "no-store").send({ clients: dependencies.service.listClients() });
  });

  app.post("/api/aigc/mcp/clients", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = request.body as Record<string, unknown> | undefined;
    if (!body || typeof body.name !== "string" || !Array.isArray(body.interfaceIds)
      || !body.interfaceIds.every((id) => typeof id === "string") || !Array.isArray(body.operations)
      || !body.operations.every((operation) => typeof operation === "string" && MCP_OPERATIONS.includes(operation as McpOperation))) {
      return sendApiError(reply, 400, "MCP_CLIENT_INPUT_INVALID", "请提供客户端名称、接口和操作范围");
    }
    try {
      return reply.header("Cache-Control", "no-store").code(201).send(await dependencies.service.create({
        name: body.name, interfaceIds: body.interfaceIds as string[], operations: body.operations as McpOperation[],
      }));
    } catch (error) { return sendMcpError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/mcp/clients/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try { await dependencies.service.revoke(request.params.id); return reply.code(204).send(); }
    catch (error) { return sendMcpError(reply, error); }
  });

  app.post("/api/aigc/mcp/uploads", async (request, reply) => {
    const client = authenticatedClient(request, dependencies.service);
    if (!client) return sendApiError(reply, 401, "MCP_AUTH_REQUIRED", "请提供有效的 MCP Bearer 令牌");
    try {
      const file = await request.file({ limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
      if (!file) return sendApiError(reply, 400, "MCP_UPLOAD_REQUIRED", "请上传媒体文件");
      const asset = await dependencies.service.upload(client, file.file, file.filename, file.mimetype);
      return reply.header("Cache-Control", "no-store").code(201).send(asset);
    } catch (error) { return sendMcpError(reply, error); }
  });

  app.get<{ Params: { taskId: string; assetId: string } }>("/api/aigc/mcp/tasks/:taskId/assets/:assetId", async (request, reply) => {
    const client = authenticatedClient(request, dependencies.service);
    if (!client) return sendApiError(reply, 401, "MCP_AUTH_REQUIRED", "请提供有效的 MCP Bearer 令牌");
    try {
      const { asset, path } = await dependencies.service.output(client, request.params.taskId, request.params.assetId);
      return reply.header("Cache-Control", "private, no-store").header("X-Content-Type-Options", "nosniff")
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(asset.name)}`)
        .type(asset.mediaType).send(createReadStream(path));
    } catch (error) { return sendMcpError(reply, error); }
  });

  app.post("/api/aigc/mcp", { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const client = authenticatedClient(request, dependencies.service);
    if (!client) return sendApiError(reply, 401, "MCP_AUTH_REQUIRED", "请提供有效的 MCP Bearer 令牌");
    const server = createMcpServer(client, dependencies.service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.setHeader("Cache-Control", "no-store");
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
        reply.raw.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603,
          message: toSafePublicMessage(error, "MCP 请求处理失败") }, id: null }));
      }
    } finally { await server.close(); }
  });

  app.get("/api/aigc/mcp", async (_request, reply) => reply.code(405).send());
  app.delete("/api/aigc/mcp", async (_request, reply) => reply.code(405).send());
}

/** 按令牌允许的操作动态注册工具，服务层仍逐次复核授权。 */
function createMcpServer(client: AigcMcpClient, service: AigcMcpService): McpServer {
  const server = new McpServer({ name: "bugpaw-aigc", version: "1.0.0" }, { maxToolInputElements: 256 });
  const register = (operation: McpOperation, name: string, description: string,
    inputSchema: Record<string, z.ZodType>, handler: (args: Record<string, unknown>) => Promise<unknown>) => {
    if (!client.operations.includes(operation)) return;
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const data = await handler(args);
        return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", data }) }] };
      } catch (error) {
        const code = error instanceof AigcMcpError ? error.code : error instanceof TypeError ? "MCP_INPUT_INVALID" : "MCP_OPERATION_FAILED";
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code,
          message: toSafePublicMessage(error, "MCP 工具执行失败") }) }] };
      }
    });
  };
  register("list", "aigc_list_interfaces", "分页列出已授权接口，或按真实 ID 读取字段和产物定义。", {
    action: z.enum(["list", "get"]), interfaceId: z.string().nullable(), offset: z.number().int().min(0).nullable(),
  }, async (args) => {
    if (args.action === "list" && args.interfaceId === null && typeof args.offset === "number") {
      return service.list(client, { offset: args.offset });
    }
    if (args.action === "get" && typeof args.interfaceId === "string" && args.offset === null) {
      return service.list(client, { interfaceId: args.interfaceId });
    }
    throw new TypeError("list 传 interfaceId=null 与 offset；get 传真实 interfaceId 与 offset=null");
  });
  register("run", "aigc_run", "异步提交 AIGC 任务。图片编辑 image 可传有序 inputId 数组，其他媒体传单个 inputId；同一次重试复用 requestKey。", {
    interfaceId: z.string().min(1).max(120), requestKey: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    parameters: z.array(z.object({ name: z.string().min(1).max(80),
      value: z.union([z.string().max(20_000), z.number(), z.boolean(), z.array(z.string().min(1).max(1_024)).min(1).max(16), z.null()]) }).strict()).max(100),
  }, async (args) => service.run(client, args as { interfaceId: string; requestKey: string; parameters: { name: string; value: string | number | boolean | string[] | null }[] }));
  register("get", "aigc_get_task", "查询当前客户端任务；成功后返回经 Bearer 认证下载的文件路径。请遵守返回的 pollAfterMs。", {
    taskId: z.string().min(1).max(120),
  }, async (args) => service.get(client, args.taskId as string));
  register("cancel", "aigc_cancel_task", "取消当前客户端任务；仅 confirmed 表示上游已确认停止。", {
    taskId: z.string().min(1).max(120),
  }, async (args) => service.cancel(client, args.taskId as string));
  register("upload", "aigc_upload_input", "上传最多 8 MiB 的图片、视频或音频，返回 inputId；更大的文件使用同令牌向 /api/v1/aigc/mcp/uploads 提交 multipart。", {
    name: z.string().min(1).max(255), mediaType: z.string().min(3).max(120), base64: z.string().min(1).max(11_184_812),
  }, async (args) => {
    const base64 = args.base64 as string;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new TypeError("base64 媒体内容无效");
    }
    const content = Buffer.from(base64, "base64");
    if (content.byteLength > 8 * 1024 * 1024) throw new TypeError("MCP 工具上传最多 8 MiB");
    return service.upload(client, Readable.from(content), args.name as string, args.mediaType as string);
  });
  register("download", "aigc_read_output", "读取最多 8 MiB 的产物并返回 base64；大文件使用 aigc_get_task 的 downloadPath 和同一 Bearer 令牌下载。", {
    taskId: z.string().min(1).max(120), assetId: z.string().min(1).max(120),
  }, async (args) => service.readSmallOutput(client, args.taskId as string, args.assetId as string));
  return server;
}

function authenticatedClient(request: FastifyRequest, service: AigcMcpService) {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? service.authenticate(authorization.slice(7)) : undefined;
}

function sendMcpError(reply: FastifyReply, error: unknown) {
  const code = error instanceof AigcMcpError ? error.code
    : error instanceof Error && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE" ? "MCP_INPUT_TOO_LARGE"
    : error instanceof TypeError ? "MCP_INPUT_INVALID" : "MCP_OPERATION_FAILED";
  const status = ["MCP_CLIENT_NOT_FOUND", "MCP_ASSET_NOT_FOUND", "MCP_TASK_NOT_FOUND", "MCP_INTERFACE_UNAVAILABLE"].includes(code) ? 404
    : code === "MCP_ACCESS_DENIED" ? 403
    : ["MCP_RATE_LIMIT", "MCP_QUOTA_EXCEEDED", "MCP_QUERY_TOO_FREQUENT", "MCP_UPLOAD_QUOTA_EXCEEDED"].includes(code) ? 429
    : code === "MCP_INPUT_TOO_LARGE" ? 413
    : code === "MCP_INPUT_INVALID" ? 400
    : code === "MCP_OPERATION_FAILED" ? 500 : 409;
  return sendApiError(reply, status, code as ApiErrorCode, toSafePublicMessage(error, "MCP 请求处理失败"));
}
