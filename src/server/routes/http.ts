import type { FastifyReply } from "fastify";
import type { ApiErrorCode } from "../../shared/api/common";
import { toSafeErrorDetails, toSafePublicMessage } from "../core/errors";

/**
 * 以统一结构返回可供前端识别的 API 错误。
 */
export function sendApiError(
  reply: FastifyReply,
  statusCode: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  const requestId = reply.request.id;
  const safeDetails = details ? toSafeErrorDetails(details) : undefined;
  reply.header("X-Request-Id", requestId);
  return reply.code(statusCode).send({
    error: {
      code,
      message: toSafePublicMessage(message, "请求失败"),
      requestId,
      ...(safeDetails && Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {}),
    },
  });
}
