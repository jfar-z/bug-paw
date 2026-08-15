import type { SessionEvent, SessionProjectionRequiredEvent, SessionSnapshotEvent } from "./chat";
import { THINKING_LEVELS, type ThinkingLevel } from "../configuration-contracts";
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
    && (value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel))
    && (value.run === undefined || isRun(value.run))
    && (value.pendingQuestion === undefined || isPendingQuestion(value.pendingQuestion));
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
  if (value.type === "thinking_level_changed") return isThinkingLevel(value.thinkingLevel);
  if (value.type === "question_pending") {
    return hasOnlyKeys(value, ["id", "sessionId", "type", "pendingQuestion"])
      && isPendingQuestion(value.pendingQuestion);
  }
  if (value.type === "question_resolved") {
    return hasOnlyKeys(value, ["id", "sessionId", "type", "questionRecordId", "state"])
      && isNonEmptyString(value.questionRecordId)
      && (value.state === "submitted" || value.state === "discarded");
  }
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
    case "tool_parameters_streaming": return isToolIdentity(value)
      && isSafeInteger(value.generatedBytes, 1)
      && (value.path === undefined || isNonEmptyString(value.path));
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
    && isNonEmptyString(value.name)
    && (value.thinkingLevels === undefined
      || (Array.isArray(value.thinkingLevels) && value.thinkingLevels.every(isThinkingLevel)));
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
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

function isPendingQuestion(value: unknown): boolean {
  if (!isRecord(value)
    || !hasOnlyKeys(value, ["id", "version", "toolCallId", "questions", "createdAt"])
    || !isNonEmptyString(value.id)
    || !isSafeInteger(value.version, 1)
    || !isNonEmptyString(value.toolCallId)
    || !isNonEmptyString(value.createdAt)
    || !Array.isArray(value.questions)
    || value.questions.length < 1
    || value.questions.length > 4) return false;

  return value.questions.every((question) => {
    if (!isRecord(question)
      || !hasOnlyKeys(question, ["id", "header", "question", "options", "multiSelect"])
      || !isNonEmptyString(question.id)
      || !isBoundedString(question.header, 12)
      || !isBoundedString(question.question, 1_000)
      || typeof question.multiSelect !== "boolean"
      || !Array.isArray(question.options)
      || question.options.length < 2
      || question.options.length > 4) return false;

    return question.options.every((option) => isRecord(option)
      && hasOnlyKeys(option, ["id", "label", "description"])
      && isNonEmptyString(option.id)
      && isBoundedString(option.label, 80)
      && isBoundedString(option.description, 500));
  });
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return isNonEmptyString(value) && Array.from(value).length <= maximum;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
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
