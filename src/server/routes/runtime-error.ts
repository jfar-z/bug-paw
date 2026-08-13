import type { FastifyReply } from "fastify";
import { PiRuntimeError } from "../pi-runtime";
import { SessionAgentMissingError } from "../session-agent";
import { sendApiError } from "./http";
import { DomainError } from "../core/errors";
import { statusForDomainError } from "../http/error-handler";
import { SessionTextError } from "../session-text-service";

/**
 * 将运行时稳定错误码映射为 HTTP 状态。
 */
export function sendRuntimeError(reply: FastifyReply, error: unknown) {
  if (error instanceof DomainError) {
    return sendApiError(reply, statusForDomainError(error.code), error.code, error.message);
  }
  if (error instanceof SessionAgentMissingError) {
    return sendApiError(reply, 409, error.code, error.message);
  }
  if (error instanceof PiRuntimeError) {
    const statusCode = error.code === "SESSION_NOT_FOUND" || error.code === "MODEL_NOT_FOUND" || error.code === "SESSION_ENTRY_NOT_FOUND"
      ? 404
      : error.code === "INVALID_SESSION_NAME" || error.code === "SESSION_HISTORY_CURSOR_INVALID" ? 400 : 409;
    return sendApiError(reply, statusCode, error.code, error.message);
  }
  if (error instanceof SessionTextError) {
    const statusCode = error.code === "SESSION_NOT_FOUND" || error.code === "SESSION_ENTRY_NOT_FOUND"
      ? 404
      : error.code === "SESSION_BRANCH_CHANGED" ? 409
        : error.code === "SESSION_TEXT_LIMIT_EXCEEDED" ? 413 : 400;
    return sendApiError(reply, statusCode, error.code, error.message);
  }
  throw error;
}
