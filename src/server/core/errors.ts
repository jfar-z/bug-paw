import type { ApiErrorCode, ApiErrorDocument } from "../../shared/api/common";

const SENSITIVE_KEY_PARTS = ["authorization", "password", "apikey", "cookie", "token", "secret"];

/** 领域与应用服务共用的稳定错误。 */
export class DomainError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }

  /** 生成可安全返回给浏览器的错误文档。 */
  toDocument(requestId: string): ApiErrorDocument {
    const details = this.details ? toSafeErrorDetails(this.details) : undefined;
    return {
      error: {
        code: this.code,
        message: toSafePublicMessage(this, "请求失败"),
        requestId,
        ...(details && Object.keys(details).length > 0 ? { details } : {}),
      },
    };
  }
}

/** 递归移除凭据类字段，避免错误上下文越过 HTTP 边界。 */
export function toSafeErrorDetails(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeRecord(value, 0);
  return sanitized ?? {};
}

/** 生成可公开展示的短错误消息，并隐藏凭据、URL 用户信息和本机绝对路径。 */
export function toSafePublicMessage(error: unknown, fallback: string, maxCharacters = 300): string {
  const source = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const sanitized = source
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ")
    .replace(/\b(Bearer|Token)\s+[^\s,;]+/giu, "$1 [已隐藏]")
    .replace(/\b(authorization|api[_ -]?key|cookie|password|secret)\s*[:=]\s*[^\s,;]+/giu, "$1: [已隐藏]")
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[已隐藏]@")
    .replace(/(^|\s)\/(?:[^\s/,;]+\/)+[^\s,;]*/gu, "$1[路径已隐藏]")
    .replace(/\b[A-Za-z]:\\(?:[^\s\\,;]+\\)+[^\s,;]*/gu, "[路径已隐藏]")
    .replace(/\s+/gu, " ")
    .trim();
  if (!sanitized) return fallback;
  return Array.from(sanitized).slice(0, maxCharacters).join("");
}

function sanitizeRecord(value: Record<string, unknown>, depth: number): Record<string, unknown> | undefined {
  if (depth >= 5) return undefined;
  const entries = Object.entries(value).flatMap(([key, item]) => {
    const normalized = key.replaceAll(/[^a-z]/giu, "").toLowerCase();
    if (SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))) return [];
    const sanitized = sanitizeValue(item, depth + 1);
    return sanitized === undefined ? [] : [[key, sanitized] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return toSafePublicMessage(value, "[已隐藏]", 1_000);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth)).filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    return sanitizeRecord(value as Record<string, unknown>, depth);
  }
  return undefined;
}
