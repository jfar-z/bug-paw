import type { FastifyInstance } from "fastify";
import { sendApiError } from "./http";

interface BrowserPreviewRouteDependencies {
  read(token: string, resourcePath: string): Promise<{ content: Buffer; mediaType: string }>;
}

/** 注册仅供隔离 Worker 使用的临时静态页面 Origin。 */
export function registerBrowserPreviewRoutes(app: FastifyInstance, preview: BrowserPreviewRouteDependencies): void {
  app.get<{ Params: { token: string; "*": string } }>("/internal/browser-preview/:token/*", async (request, reply) => {
    try {
      const resource = await preview.read(request.params.token, request.params["*"]);
      return reply
        .header("Cache-Control", "no-store")
        .header("Content-Type", resource.mediaType)
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        .send(resource.content);
    } catch {
      // 不区分 token、过期和路径错误，避免把内部授权状态暴露给普通请求。
      return sendApiError(reply, 404, "NOT_FOUND", "预览资源不存在");
    }
  });
}
