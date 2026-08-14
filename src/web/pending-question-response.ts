import type { QuestionResolution } from "../shared/question-response-protocol";
import { reduceTimeline, type ConversationEntry } from "./conversation-timeline";

export interface PendingQuestionResponse {
  /**
   * 待权威快照确认的回答所属会话。
   */
  sessionId: string;

  /**
   * 提交回答时所在的 Pi 历史分支。
   */
  branchToken: string;

  /**
   * 回答接口返回的权威解析结果。
   */
  resolution: QuestionResolution;
}

export interface PendingQuestionResponseReconciliation {
  /**
   * 应交给消息窗口渲染的稳定时间线。
   */
  timeline: ConversationEntry[];

  /**
   * 尚未由服务端历史协议确认的回答状态。
   */
  pending?: PendingQuestionResponse;
}

/**
 * 记录成功提交的回答，供运行中快照覆盖时间线时重新协调。
 */
export function createPendingQuestionResponse(
  sessionId: string,
  branchToken: string,
  resolution: QuestionResolution,
): PendingQuestionResponse {
  return { sessionId, branchToken, resolution };
}

/**
 * 在权威历史写入回答协议前稳定保留回答卡片，并在分支变化时停止回填。
 */
export function reconcilePendingQuestionResponse(
  sessionId: string,
  branchToken: string,
  timeline: ConversationEntry[],
  pending: PendingQuestionResponse | undefined,
): PendingQuestionResponseReconciliation {
  if (!pending || pending.sessionId !== sessionId) {
    return { timeline, pending };
  }
  if (pending.branchToken !== branchToken) {
    return { timeline, pending: undefined };
  }
  if (containsResolution(timeline, pending.resolution)) {
    return { timeline, pending: undefined };
  }
  return {
    timeline: reduceTimeline(timeline, {
      type: "question_resolved",
      resolution: pending.resolution,
    }),
    pending,
  };
}

/** 判断快照是否已经携带当前问题的权威回答。 */
function containsResolution(
  timeline: ConversationEntry[],
  expected: QuestionResolution,
): boolean {
  return timeline.some((entry) => entry.type === "question_response"
    && (entry.resolution.resolutionId === expected.resolutionId
      || entry.resolution.questionRecordId === expected.questionRecordId));
}
