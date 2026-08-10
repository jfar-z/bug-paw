import { describe, expect, it } from "vitest";

import { isProjectionRequiredEvent, isSessionEvent, isSessionSnapshotEvent } from "./chat-validation";

describe("Chat SSE 轻量校验", () => {
  it("接受正式快照和增量，拒绝缺少运行标识的事件", () => {
    expect(isSessionSnapshotEvent({
      id: 0,
      type: "snapshot",
      sessionId: "s1",
      messages: [],
      lastEventId: 0,
    })).toBe(true);
    expect(isSessionEvent({ id: 1, type: "text_delta", sessionId: "s1", runId: "r1", delta: "x" })).toBe(true);
    expect(isSessionEvent({ id: 1, type: "text_delta", sessionId: "s1", delta: "x" })).toBe(false);
    expect(isSessionEvent({ id: 2, type: "model_changed", sessionId: "s1", model: { provider: "openai", id: "gpt", name: "GPT" } })).toBe(true);
    expect(isSessionEvent({ id: 3, type: "session_renamed", sessionId: "s1", runId: "r1", name: "登录故障排查" })).toBe(true);
    expect(isSessionEvent({ id: 3, type: "session_renamed", sessionId: "s1", name: "登录故障排查" })).toBe(false);
    expect(isProjectionRequiredEvent({ id: 7, type: "projection_required", sessionId: "s1", lastEventId: 7 })).toBe(true);
  });
});
