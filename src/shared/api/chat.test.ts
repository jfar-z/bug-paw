import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import { ChatPromptInputSchema, SessionEventSchema, SessionProjectionSchema, SessionSnapshotEventSchema } from "./chat";

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
    expect(Check(SessionProjectionSchema, {
      sessionId: "s1",
      projectionVersion: 2,
      lastEventId: 9,
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, turnCount: 0 },
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
      history: { branchToken: "branch-a", hasMoreBefore: false, turnCount: 0 },
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
});
