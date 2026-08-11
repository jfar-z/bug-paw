import type { ErrorToastInput } from "./error-toast-types";
import { ApiClientError } from "./api";

/** 判断错误是否来自用户取消、组件卸载或请求替换。 */
export function isCancelledError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** 将未知异常压缩为不包含底层敏感信息的 Toast 输入。 */
export function toUnexpectedErrorNotice(error: unknown, operation: string): ErrorToastInput {
  const base: ErrorToastInput = {
    operation,
    title: "操作未完成",
    summary: "请稍后重试；如问题持续发生，请查看详情并提供请求标识。",
  };
  if (!(error instanceof ApiClientError)) return base;
  return {
    ...base,
    code: error.code,
    status: error.status,
    ...(error.requestId ? { requestId: error.requestId } : {}),
    safeDetail: error.message,
  };
}

/** 为同一次服务端失败生成稳定去重标识。 */
export function unexpectedErrorDedupeKey(input: ErrorToastInput): string {
  if (input.requestId) return `${input.requestId}:${input.code ?? "UNKNOWN"}`;
  return `${input.operation}:${input.code ?? "UNKNOWN"}:${input.summary}`;
}
