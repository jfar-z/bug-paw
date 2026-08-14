import { describe, expect, it } from "vitest";

import type { QuestionResolution } from "../shared/question-response-protocol";
import type { PendingQuestionProjection } from "../shared/session-question-contracts";
import type { AgentTurn, ConversationEntry, QuestionResponseEntry } from "./conversation-timeline";
import {
  createPendingQuestionResponse,
  reconcilePendingQuestionResponse,
} from "./pending-question-response";

const pendingQuestion: PendingQuestionProjection = {
  id: "question-1",
  version: 1,
  toolCallId: "ask-1",
  questions: [{
    id: "q-1",
    header: "范围",
    question: "需要处理哪些内容？",
    options: [
      { id: "o-1", label: "全部", description: "处理全部内容" },
      { id: "o-2", label: "部分", description: "只处理部分内容" },
    ],
    multiSelect: false,
  }],
  createdAt: "2026-08-15T08:00:00.000Z",
};

const resolution: QuestionResolution = {
  resolutionId: "resolution-1",
  questionRecordId: "question-1",
  status: "submitted",
  answers: [{ questionId: "q-1", kind: "options", optionIds: ["o-2"] }],
  unansweredQuestionIds: [],
};

const questionTurn: AgentTurn = {
  id: "agent-question",
  type: "agent",
  blocks: [{
    id: "tool-ask-1",
    type: "tool",
    callId: "ask-1",
    name: "ask_user",
    args: {},
    details: { type: "question_pending", pendingQuestion },
    status: "completed",
  }],
};

describe("待确认提问回答协调", () => {
  it("运行中快照尚未包含回答协议时仍在原提问后补回回答卡片", () => {
    const pending = createPendingQuestionResponse("session-1", "branch-a", resolution);

    const result = reconcilePendingQuestionResponse(
      "session-1",
      "branch-a",
      [questionTurn],
      pending,
    );

    expect(result.pending).toBe(pending);
    expect(result.timeline.map((entry) => entry.type)).toEqual(["agent", "question_response"]);
    expect((result.timeline[1] as QuestionResponseEntry).resolution).toEqual(resolution);
  });

  it("权威快照已包含同一回答后清除待确认状态且不重复插入", () => {
    const pending = createPendingQuestionResponse("session-1", "branch-a", resolution);
    const confirmed: ConversationEntry[] = [questionTurn, {
      id: "question-response-server",
      type: "question_response",
      pendingQuestion,
      resolution: { ...resolution, resolutionId: "resolution-server" },
    }];

    expect(reconcilePendingQuestionResponse("session-1", "branch-a", confirmed, pending))
      .toEqual({ timeline: confirmed, pending: undefined });
  });

  it("其他会话不会补入回答卡片并保留原会话待确认状态", () => {
    const pending = createPendingQuestionResponse("session-1", "branch-a", resolution);
    const otherTimeline: ConversationEntry[] = [];

    expect(reconcilePendingQuestionResponse("session-2", "branch-b", otherTimeline, pending))
      .toEqual({ timeline: otherTimeline, pending });
  });

  it("当前会话分支变化后清除旧分支待确认状态且不补入回答卡片", () => {
    const pending = createPendingQuestionResponse("session-1", "branch-a", resolution);

    expect(reconcilePendingQuestionResponse("session-1", "branch-b", [questionTurn], pending))
      .toEqual({ timeline: [questionTurn], pending: undefined });
  });
});
