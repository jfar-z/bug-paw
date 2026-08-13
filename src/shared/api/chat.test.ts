import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import { ChatPromptInputSchema, SessionEventSchema, SessionProjectionSchema, SessionSnapshotEventSchema } from "./chat";
import { ApiErrorCodeSchema } from "./common";

const pendingQuestion = {
  id: "record-1",
  version: 1,
  toolCallId: "call-1",
  createdAt: "2026-08-13T00:00:00.000Z",
  questions: [{
    id: "question-1",
    header: "方案",
    question: "选择方案",
    multiSelect: false,
    options: [
      { id: "option-1", label: "A", description: "方案 A" },
      { id: "option-2", label: "B", description: "方案 B" },
    ],
  }],
};

describe("Chat API Schema", () => {
  it("拒绝缺少事件序号或使用未知类型的 Session Event", () => {
    expect(Check(SessionEventSchema, {
      sessionId: "s1",
      runId: "r1",
      type: "text_delta",
      delta: "x",
    })).toBe(false);
    expect(Check(SessionEventSchema, {
      id: 1,
      sessionId: "s1",
      runId: "r1",
      type: "unknown",
    })).toBe(false);
  });

  it("接受带单调序号的文本事件和完整 Projection", () => {
    expect(Check(SessionEventSchema, {
      id: 1,
      sessionId: "s1",
      runId: "r1",
      type: "text_delta",
      delta: "x",
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 2,
      sessionId: "s1",
      type: "model_changed",
      model: { provider: "openai", id: "gpt", name: "GPT" },
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 3,
      sessionId: "s1",
      type: "session_renamed",
      name: "登录故障排查",
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 3,
      sessionId: "s1",
      runId: "r1",
      type: "session_renamed",
      name: "登录故障排查",
    })).toBe(false);
    expect(Check(SessionEventSchema, {
      id: 4,
      sessionId: "s1",
      type: "thinking_level_changed",
      thinkingLevel: "high",
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 5,
      sessionId: "s1",
      type: "thinking_level_changed",
      thinkingLevel: "invalid",
    })).toBe(false);
    expect(Check(SessionProjectionSchema, {
      sessionId: "s1",
      projectionVersion: 2,
      lastEventId: 9,
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      thinkingLevel: "medium",
    })).toBe(true);
    expect(Check(SessionProjectionSchema, {
      sessionId: "s1",
      projectionVersion: 2,
      lastEventId: 9,
      messages: [],
    })).toBe(false);
    expect(Check(SessionSnapshotEventSchema, {
      id: 0,
      sessionId: "s1",
      type: "snapshot",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      thinkingLevel: "xhigh",
      lastEventId: 0,
    })).toBe(true);
  });

  it("约束公开消息输入而不接受服务端调度字段", () => {
    expect(Check(ChatPromptInputSchema, {
      text: "你好",
      filePaths: ["docs/spec.md"],
      references: [],
    })).toBe(true);
    expect(Check(ChatPromptInputSchema, {
      text: "你好",
      protocolPrompt: "internal",
    })).toBe(false);
  });

  it("在 Projection、Snapshot 和严格控制事件中共享待回答问题", () => {
    expect(Check(SessionProjectionSchema, {
      sessionId: "s1",
      projectionVersion: 2,
      lastEventId: 9,
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      pendingQuestion,
    })).toBe(true);
    expect(Check(SessionSnapshotEventSchema, {
      id: 0,
      sessionId: "s1",
      type: "snapshot",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      lastEventId: 0,
      pendingQuestion,
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 10,
      sessionId: "s1",
      type: "question_pending",
      pendingQuestion,
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 11,
      sessionId: "s1",
      type: "question_resolved",
      questionRecordId: "record-1",
      state: "submitted",
    })).toBe(true);
    expect(Check(SessionEventSchema, {
      id: 11,
      sessionId: "s1",
      type: "question_resolved",
      questionRecordId: "record-1",
      state: "submitted",
      answers: [],
    })).toBe(false);
  });

  it("公开稳定的问题处理错误码", () => {
    for (const code of [
      "QUESTION_NOT_FOUND",
      "QUESTION_STATE_CONFLICT",
      "QUESTION_VERSION_CONFLICT",
      "QUESTION_BRANCH_CHANGED",
      "QUESTION_ANSWER_INVALID",
      "SESSION_AWAITING_USER",
    ]) {
      expect(Check(ApiErrorCodeSchema, code)).toBe(true);
    }
  });
});
