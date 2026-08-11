import type { SessionEvent, SessionProjectionRequiredEvent, SessionSnapshotEvent } from "./chat";
import { isSessionHistoryPage } from "../session-history-contracts";

/** 轻量校验 SSE 快照，避免浏览器为单条事件加载完整 Schema 执行器。 */
export function isSessionSnapshotEvent(value: unknown): value is SessionSnapshotEvent {
  if (!isRecord(value)) return false;
  return value.type === "snapshot"
    && isSafeInteger(value.id, 0)
    && isNonEmptyString(value.sessionId)
    && Array.isArray(value.messages)
    && isSessionHistoryPage(value.history)
    && isSafeInteger(value.lastEventId, 0)
    && (value.model === undefined || isModel(value.model))
    && (value.run === undefined || isRun(value.run));
}

/** 校验要求客户端重新读取 Projection 的轻量控制事件。 */
export function isProjectionRequiredEvent(value: unknown): value is SessionProjectionRequiredEvent {
  return isRecord(value)
    && value.type === "projection_required"
    && isSafeInteger(value.id, 0)
    && isNonEmptyString(value.sessionId)
    && isSafeInteger(value.lastEventId, 0);
}

/** 校验全部有序 SSE 增量的公共身份字段和事件专属字段。 */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!isRecord(value)
    || !isSafeInteger(value.id, 1)
    || !isNonEmptyString(value.sessionId)
    || typeof value.type !== "string") return false;
  if (value.type === "model_changed") return isModel(value.model);
  // 自动标题可能在所属 Run 结束后才到达，因此不绑定任何 Run。
  if (value.type === "session_renamed") {
    return value.runId === undefined
      && isNonEmptyString(value.name)
      && Array.from(value.name).length <= 120;
  }
  if (!isNonEmptyString(value.runId)) return false;
  switch (value.type) {
    case "run_started": return isRun(value.run);
    case "text_delta":
    case "thinking_delta": return typeof value.delta === "string";
    case "thinking_finished":
    case "completed":
    case "aborted": return true;
    case "tool_preparing": return isToolIdentity(value);
    case "tool_prepared": return isToolIdentity(value) && "args" in value;
    case "tool_started": return isToolIdentity(value) && "args" in value;
    case "tool_updated": return isToolIdentity(value) && "partialResult" in value;
    case "tool_finished": return isToolIdentity(value) && "result" in value && typeof value.isError === "boolean";
    case "error": return isNonEmptyString(value.code) && typeof value.message === "string";
    default: return false;
  }
}

function isToolIdentity(value: Record<string, unknown>): boolean {
  return isNonEmptyString(value.callId) && isNonEmptyString(value.toolName);
}

function isModel(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.provider)
    && isNonEmptyString(value.id)
    && isNonEmptyString(value.name);
}

function isRun(value: unknown): boolean {
  return isRecord(value)
    && isNonEmptyString(value.runId)
    && isNonEmptyString(value.sessionId)
    && ["queued", "running", "completed", "aborted", "error", "interrupted"].includes(String(value.status))
    && isNonEmptyString(value.startedAt)
    && (value.finishedAt === undefined || isNonEmptyString(value.finishedAt))
    && (value.error === undefined || typeof value.error === "string");
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
