import type { PendingQuestionProjection } from "../../shared/session-question-contracts";
import { parseQuestionResponseProtocol } from "../../shared/question-response-protocol";
import {
  SessionQuestionRepository,
  type SessionQuestionRecord,
} from "./session-question-repository";

export interface QuestionFacts {
  successfulQuestionRecordIds: Set<string>;
  resolutionIds: Set<string>;
}

export interface QuestionResolvedNotice {
  questionRecordId: string;
  state: "submitted" | "discarded";
}

/** 扫描 Pi 当前分支中与问题状态有关的结构化事实。 */
export function inspectQuestionFacts(messages: readonly unknown[]): QuestionFacts {
  const successfulQuestionRecordIds = new Set<string>();
  const resolutionIds = new Set<string>();

  for (const message of messages) {
    try {
      if (!isRecord(message)) continue;
      if (message.role === "toolResult"
        && message.toolName === "ask_user"
        && message.isError === false
        && isRecord(message.details)
        && message.details.type === "question_pending"
        && isRecord(message.details.pendingQuestion)
        && typeof message.details.pendingQuestion.id === "string") {
        successfulQuestionRecordIds.add(message.details.pendingQuestion.id);
      }
      if (message.role !== "user") continue;
      for (const text of readMessageTextBlocks(message.content)) {
        const parsed = parseQuestionResponseProtocol(text);
        if (parsed.resolution) resolutionIds.add(parsed.resolution.resolutionId);
      }
    } catch {
      // 单条损坏历史不得阻止会话恢复，数据库状态仍由后续事实继续校验。
    }
  }
  return { successfulQuestionRecordIds, resolutionIds };
}

/** 根据当前 Pi 分支事实修复唯一未解决问题。 */
export function reconcileSessionQuestions(input: {
  agentId: string;
  sessionId: string;
  messages: readonly unknown[];
  repository: SessionQuestionRepository;
  missingReason?: "branch_changed" | "orphaned";
}): QuestionResolvedNotice | undefined {
  const current = input.repository.findPending(input.agentId, input.sessionId);
  if (!current) return undefined;
  const facts = inspectQuestionFacts(input.messages);

  if (current.state === "resolving") {
    if (current.resolutionId && facts.resolutionIds.has(current.resolutionId)) {
      const completed = input.repository.completeResolution(
        current.id,
        current.resolutionId,
        current.resumedRunId ?? `reconciled-${current.resolutionId}`,
      );
      return toResolvedNotice(completed);
    }
    input.repository.restorePending(current.id, current.resolutionId ?? "");
    return undefined;
  }

  if (!facts.successfulQuestionRecordIds.has(current.id)) {
    const discarded = input.repository.discardOrphan(current.id, input.missingReason ?? "orphaned");
    return toResolvedNotice(discarded);
  }
  return undefined;
}

/** 为单个 Agent 提供 Runtime 所需的同步问题投影和一次性通知队列。 */
export class SessionQuestionRuntimeState {
  private readonly resolvedNotices = new Map<string, QuestionResolvedNotice>();

  constructor(
    private readonly agentId: string,
    private readonly repository: SessionQuestionRepository,
  ) {}

  /** 返回浏览器可见的 pending 投影；resolving 不允许重复提交。 */
  findPending(sessionId: string): PendingQuestionProjection | undefined {
    const record = this.repository.findPending(this.agentId, sessionId);
    return record?.state === "pending" ? toPendingProjection(record) : undefined;
  }

  /** 用当前分支事实对账，并缓存需要发布的终态通知。 */
  reconcile(
    sessionId: string,
    messages: readonly unknown[],
    missingReason: "branch_changed" | "orphaned" = "orphaned",
  ): void {
    const notice = reconcileSessionQuestions({
      agentId: this.agentId,
      sessionId,
      messages,
      repository: this.repository,
      missingReason,
    });
    if (notice) this.resolvedNotices.set(sessionId, notice);
  }

  /** API 完成回答或放弃后登记一个不含答案正文的通知。 */
  recordResolved(sessionId: string, record: SessionQuestionRecord): void {
    const notice = toResolvedNotice(record);
    if (notice) this.resolvedNotices.set(sessionId, notice);
  }

  /** 消费一次终态通知。 */
  consumeResolvedEvent(sessionId: string): QuestionResolvedNotice | undefined {
    const notice = this.resolvedNotices.get(sessionId);
    this.resolvedNotices.delete(sessionId);
    return notice;
  }
}

/** 把完整记录缩减为浏览器允许读取的 pending 字段。 */
export function toPendingProjection(record: SessionQuestionRecord): PendingQuestionProjection {
  return {
    id: record.id,
    version: record.version,
    toolCallId: record.toolCallId,
    questions: record.questions,
    createdAt: record.createdAt,
  };
}

function toResolvedNotice(record: SessionQuestionRecord): QuestionResolvedNotice | undefined {
  return record.state === "submitted" || record.state === "discarded"
    ? { questionRecordId: record.id, state: record.state }
    : undefined;
}

function readMessageTextBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => isRecord(block) && block.type === "text" && typeof block.text === "string"
    ? [block.text]
    : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
