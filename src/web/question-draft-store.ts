import type { PendingQuestionProjection } from "../shared/session-question-contracts";

export const QUESTION_DRAFT_PREFIX = "bug-paw.question-draft.v1";
const QUESTION_DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export interface QuestionDraftAnswer {
  optionIds: string[];
  text: string;
}

export interface QuestionDraft {
  questionIndex: number;
  answers: Record<string, QuestionDraftAnswer>;
  collapsed: boolean;
  updatedAt: string;
}

/** 生成包含部署、会话、问题与版本的浏览器草稿键。 */
export function questionDraftStorageKey(sessionId: string, pending: Pick<PendingQuestionProjection, "id" | "version">): string {
  const deployment = typeof window === "undefined" ? "server" : window.location.origin;
  return [QUESTION_DRAFT_PREFIX, deployment, sessionId, pending.id, String(pending.version)]
    .map((part, index) => index === 0 ? part : encodeURIComponent(part))
    .join(":");
}

/** 读取并按服务端权威问题过滤浏览器草稿。 */
export function readQuestionDraft(
  sessionId: string,
  pending: PendingQuestionProjection,
  now = new Date(),
): QuestionDraft {
  const empty = createEmptyQuestionDraft();
  try {
    const key = questionDraftStorageKey(sessionId, pending);
    const raw = window.localStorage.getItem(key);
    if (!raw) return empty;
    const stored: unknown = JSON.parse(raw);
    if (!isRecord(stored)
      || stored.questionRecordId !== pending.id
      || stored.version !== pending.version
      || !isRecord(stored.draft)) {
      window.localStorage.removeItem(key);
      return empty;
    }
    const updatedAt = typeof stored.draft.updatedAt === "string" ? stored.draft.updatedAt : "";
    const updatedTime = Date.parse(updatedAt);
    if (!Number.isFinite(updatedTime) || now.getTime() - updatedTime > QUESTION_DRAFT_MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return empty;
    }
    return sanitizeDraft(stored.draft, pending, updatedAt);
  } catch {
    // 浏览器禁用或损坏本地存储时退化为空草稿，不影响提问处理。
    return empty;
  }
}

/** 将草稿写入当前浏览器；任何存储异常均局部降级。 */
export function writeQuestionDraft(sessionId: string, pending: PendingQuestionProjection, draft: QuestionDraft): void {
  try {
    window.localStorage.setItem(questionDraftStorageKey(sessionId, pending), JSON.stringify({
      questionRecordId: pending.id,
      version: pending.version,
      draft,
    }));
  } catch {
    // localStorage 配额或隐私限制不应阻断当前页面回答。
  }
}

/** 删除指定待回答问题的浏览器草稿。 */
export function removeQuestionDraft(sessionId: string, pending: Pick<PendingQuestionProjection, "id" | "version">): void {
  try {
    window.localStorage.removeItem(questionDraftStorageKey(sessionId, pending));
  } catch {
    // 删除失败不改变服务端权威状态。
  }
}

/** 清除所有 BugPaw 问题草稿，同时保留主题等无关设置。 */
export function clearAllQuestionDrafts(): void {
  try {
    const keys = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
      .filter((key): key is string => typeof key === "string" && key.startsWith(`${QUESTION_DRAFT_PREFIX}:`));
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // 认证跳转不能被浏览器存储异常阻断。
  }
}

export function createEmptyQuestionDraft(): QuestionDraft {
  return { questionIndex: 0, answers: {}, collapsed: false, updatedAt: new Date().toISOString() };
}

function sanitizeDraft(value: Record<string, unknown>, pending: PendingQuestionProjection, updatedAt: string): QuestionDraft {
  const answers: Record<string, QuestionDraftAnswer> = {};
  const rawAnswers = isRecord(value.answers) ? value.answers : {};
  pending.questions.forEach((question) => {
    const raw = rawAnswers[question.id];
    if (!isRecord(raw)) return;
    const knownOptions = new Set(question.options.map((option) => option.id));
    const text = typeof raw.text === "string" ? raw.text : "";
    const optionIds = text.trim()
      ? []
      : Array.isArray(raw.optionIds)
        ? raw.optionIds.filter((id): id is string => typeof id === "string" && knownOptions.has(id))
        : [];
    answers[question.id] = {
      optionIds: question.multiSelect ? [...new Set(optionIds)] : optionIds.slice(0, 1),
      text,
    };
  });
  const questionIndex = typeof value.questionIndex === "number" && Number.isInteger(value.questionIndex)
    && value.questionIndex >= 0 && value.questionIndex < pending.questions.length
    ? value.questionIndex
    : 0;
  return {
    questionIndex,
    answers,
    collapsed: value.collapsed === true,
    updatedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
