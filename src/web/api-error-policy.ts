import type { ErrorToastInput } from "./error-toast-types";
import { ApiClientError } from "./api";

/** 判断错误是否来自用户取消、组件卸载或请求替换。 */
export function isCancelledError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 将异常整理为保留具体故障事实且不包含明显敏感信息的 Toast 输入。 */
export function toUnexpectedErrorNotice(error: unknown, operation: string): ErrorToastInput {
  if (error instanceof ApiClientError) {
    return {
      operation,
      title: `${operation}失败`,
      summary: error.message,
      code: error.code,
      status: error.status,
      ...(error.requestId ? { requestId: error.requestId } : {}),
      safeDetail: apiErrorDetail(error),
    };
  }
  if (error instanceof Error) {
    const message = sanitizeClientMessage(error.message);
    return {
      operation,
      title: `${operation}失败`,
      summary: message || `前端在“${operation}”阶段捕获到未提供消息的 ${error.name || "Error"}`,
      code: "CLIENT_RUNTIME_ERROR",
      safeDetail: `异常类型：${error.name || "Error"}`,
    };
  }
  return {
    operation,
    title: `${operation}失败`,
    summary: `前端在“${operation}”阶段捕获到非 Error 异常`,
    code: "CLIENT_NON_ERROR_THROWN",
  };
}

/** 组合 API 错误的稳定诊断字段，避免详情区重复模糊提示。 */
function apiErrorDetail(error: ApiClientError): string {
  const parts = [
    `错误码：${error.code}`,
    error.status > 0 ? `HTTP 状态：${error.status}` : "HTTP 状态：未收到响应",
  ];
  return parts.join("；");
}

/** 清理前端运行时错误消息中的控制字符和疑似凭据。 */
function sanitizeClientMessage(message: string): string {
  return message
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\b(Bearer|Token)\s+[^\s,;]+/giu, "$1 [已隐藏]")
    .replace(/\b(authorization|api[_ -]?key|cookie|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1: [已隐藏]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
}

/** 为同一次服务端失败生成稳定去重标识。 */
export function unexpectedErrorDedupeKey(input: ErrorToastInput): string {
  if (input.requestId) return `${input.requestId}:${input.code ?? "UNKNOWN"}`;
  return `${input.operation}:${input.code ?? "UNKNOWN"}:${input.summary}`;
}
