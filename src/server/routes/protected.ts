import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";

/**
 * 验证当前请求的本地登录会话，失败时直接发送统一错误。
 */
export async function requireAuthentication(
  request: FastifyRequest,
  reply: FastifyReply,
  authService: AuthService,
): Promise<boolean> {
  if (await authService.isAuthenticated(request)) {
    return true;
  }
  sendApiError(reply, 401, "AUTH_REQUIRED", "请先登录");
  return false;
}
