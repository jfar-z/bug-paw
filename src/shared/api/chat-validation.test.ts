import { describe, expect, it } from "vitest";

import { isProjectionRequiredEvent, isSessionEvent, isSessionSnapshotEvent } from "./chat-validation";

describe("Chat SSE 轻量校验", () => {
  it("接受正式快照、会话级事件和运行级增量", () => {
    expect(isSessionSnapshotEvent({
      id: 0,
      type: "snapshot",
      sessionId: "s1",
      messages: [],
      history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
      lastEventId: 0,
    })).toBe(true);
    expect(isSessionSnapshotEvent({
      id: 0,
      type: "snapshot",
      sessionId: "s1",
      messages: [],
      lastEventId: 0,
    })).toBe(false);
    expect(isSessionEvent({ id: 1, type: "text_delta", sessionId: "s1", runId: "r1", delta: "x" })).toBe(true);
    expect(isSessionEvent({ id: 1, type: "text_delta", sessionId: "s1", delta: "x" })).toBe(false);
    expect(isSessionEvent({ id: 2, type: "model_changed", sessionId: "s1", model: { provider: "openai", id: "gpt", name: "GPT" } })).toBe(true);
    expect(isSessionEvent({ id: 3, type: "session_renamed", sessionId: "s1", runId: "r1", name: "登录故障排查" })).toBe(false);
    expect(isSessionEvent({ id: 3, type: "session_renamed", sessionId: "s1", name: "登录故障排查" })).toBe(true);
    expect(isProjectionRequiredEvent({ id: 7, type: "projection_required", sessionId: "s1", lastEventId: 7 })).toBe(true);
  });

  it("校验工具准备开始与参数完成事件", () => {
    expect(isSessionEvent({
      id: 1,
      type: "tool_preparing",
      sessionId: "s1",
      runId: "r1",
      callId: "call-1",
      toolName: "write",
    })).toBe(true);
    expect(isSessionEvent({
      id: 2,
      type: "tool_prepared",
      sessionId: "s1",
      runId: "r1",
      callId: "call-1",
      toolName: "write",
      args: { path: "src/app.ts", content: "内容" },
    })).toBe(true);
    expect(isSessionEvent({
      id: 3,
      type: "tool_parameters_streaming",
      sessionId: "s1",
      runId: "r1",
      callId: "call-1",
      toolName: "write",
      generatedBytes: 512,
      path: "src/app.ts",
    })).toBe(true);
    expect(isSessionEvent({
      id: 3,
      type: "tool_preparing",
      sessionId: "s1",
      runId: "r1",
      callId: "",
      toolName: "write",
    })).toBe(false);
    expect(isSessionEvent({
      id: 4,
      type: "tool_parameters_streaming",
      sessionId: "s1",
      runId: "r1",
      callId: "call-1",
      toolName: "write",
      generatedBytes: 0,
    })).toBe(false);
  });
});
