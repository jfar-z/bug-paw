/** 检索降级或内容不完整时返回的事实性警告。 */
export interface ToolWarning {
  code: string;
  message: string;
}

/** 检索工具统一响应，只表达数据、状态和错误事实。 */
export type ToolResponse<TData, TMetadata extends Record<string, unknown>> =
  | { status: "ok" | "empty" | "partial"; data: TData; metadata: TMetadata; warnings: ToolWarning[] }
  | { status: "error"; error: { code: string; message: string; retryable: boolean } };

/** 创建完整成功响应。 */
export function okResponse<TData, TMetadata extends Record<string, unknown>>(
  data: TData,
  metadata: TMetadata,
): ToolResponse<TData, TMetadata> {
  return { status: "ok", data, metadata, warnings: [] };
}

/** 创建无命中响应。 */
export function emptyResponse<TData, TMetadata extends Record<string, unknown>>(
  data: TData,
  metadata: TMetadata,
): ToolResponse<TData, TMetadata> {
  return { status: "empty", data, metadata, warnings: [] };
}

/** 创建带事实性警告的部分成功响应。 */
export function partialResponse<TData, TMetadata extends Record<string, unknown>>(
  data: TData,
  metadata: TMetadata,
  warnings: ToolWarning[],
): ToolResponse<TData, TMetadata> {
  return { status: "partial", data, metadata, warnings };
}

/** 创建不携带行为建议的错误响应。 */
export function errorResponse(
  code: string,
  message: string,
  retryable: boolean,
): ToolResponse<never, never> {
  return { status: "error", error: { code, message, retryable } };
}

/** 将统一响应序列化为 Pi SDK 工具结果。 */
export function toPiToolResult<TData, TMetadata extends Record<string, unknown>>(
  response: ToolResponse<TData, TMetadata>,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }],
    details: {},
  };
}
