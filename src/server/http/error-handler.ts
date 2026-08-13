import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiErrorCode } from "../../shared/api/common";
import { DomainError } from "../core/errors";

const STATUS_BY_ERROR_CODE: Partial<Record<ApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  AGENT_NOT_FOUND: 404,
  AGENT_ARCHIVED: 409,
  AGENT_HAS_SESSIONS: 409,
  AGENT_REMOVAL_IN_PROGRESS: 409,
  KNOWLEDGE_COMMIT_FAILED: 500,
  KNOWLEDGE_ROLLBACK_FAILED: 500,
  AGENT_DELETE_ROLLBACK_FAILED: 500,
  SESSION_NOT_FOUND: 404,
  SESSION_ARCHIVED: 409,
  VERSION_CONFLICT: 409,
  SESSION_BUSY: 409,
  SESSION_AGENT_CONFLICT: 409,
  SESSION_AWAITING_USER: 409,
  QUESTION_NOT_FOUND: 404,
  QUESTION_ANSWER_INVALID: 400,
  QUESTION_VERSION_CONFLICT: 409,
  QUESTION_STATE_CONFLICT: 409,
  QUESTION_BRANCH_CHANGED: 409,
  INSTANCE_ALREADY_RUNNING: 409,
  RUNTIME_GENERATION_RETIRED: 409,
  CLIENT_TOO_SLOW: 429,
  OPERATION_ABORTED: 409,
  CONFIG_COMMIT_FAILED: 500,
  CONFIG_ROLLBACK_FAILED: 500,
  IMPORT_PREVIEW_EXPIRED: 410,
  AGENT_WORKSPACE_COMMIT_FAILED: 500,
  CHECKPOINT_WRITE_FAILED: 500,
  WORKSPACE_SCAN_LIMIT: 413,
  INVALID_MESSAGE: 400,
  INVALID_ATTACHMENT: 400,
  INVALID_REFERENCE: 400,
  INVALID_EVENT_CURSOR: 400,
  UNKNOWN_COMMAND: 400,
  API_RESPONSE_INVALID: 502,
  INTERNAL_ERROR: 500,
};

/** 注册 API 统一错误边界，未知异常仅在服务端日志保留原始信息。 */
export function registerApiErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = exposeRequestId(request, reply);
    if (error instanceof DomainError) {
      return reply.code(statusForDomainError(error.code)).send(error.toDocument(requestId));
    }
    if (isValidationError(error)) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: "请求参数不符合接口约束",
          requestId,
        },
      });
    }
    request.log.error({ err: error, requestId }, "未处理的 API 异常");
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务暂时不可用",
        requestId,
      },
    });
  });
}

/** 把稳定错误码映射为 HTTP 状态，供仍在迁移中的 Route 复用。 */
export function statusForDomainError(code: ApiErrorCode): number {
  return STATUS_BY_ERROR_CODE[code] ?? 400;
}

/** 为直接返回的路由错误补充与响应头一致的请求标识。 */
export function exposeRequestId(request: FastifyRequest, reply: FastifyReply): string {
  const requestId = request.id;
  reply.header("X-Request-Id", requestId);
  return requestId;
}

function isValidationError(error: unknown): error is FastifyError {
  return typeof error === "object" && error !== null && "validation" in error
    && Array.isArray((error as { validation?: unknown }).validation);
}
