import { beforeEach, describe, expect, it } from "vitest";

import {
  ChatInteractionCoordinator,
  clearChatInteractionTrace,
  readChatInteractionTrace,
} from "./chat-interaction-coordinator";

describe("ChatInteractionCoordinator", () => {
  beforeEach(() => clearChatInteractionTrace());

  it("同一通道只接受最后一次交互", () => {
    const coordinator = new ChatInteractionCoordinator();
    const first = coordinator.begin("session-transition", { sessionId: "session-1" });
    const second = coordinator.begin("session-transition", { sessionId: "session-2" });

    expect(coordinator.guard(first, "open-response")).toBe(false);
    expect(coordinator.guard(second, "open-response")).toBe(true);
    expect(readChatInteractionTrace()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "session-transition",
        generation: first.generation,
        status: "discarded",
        checkpoint: "open-response",
      }),
    ]));
  });

  it("轨迹有界且拒绝记录消息和凭据字段", () => {
    const coordinator = new ChatInteractionCoordinator();
    for (let index = 0; index < 140; index += 1) {
      coordinator.begin("message-send", {
        sessionId: `session-${index}`,
        messageText: "不应记录的正文",
        credential: "不应记录的凭据",
      });
    }

    const trace = readChatInteractionTrace();
    expect(trace).toHaveLength(128);
    expect(trace.at(-1)?.details).toEqual({ sessionId: "session-139" });
  });

  it("主动失效后拒绝原有异步结果", () => {
    const coordinator = new ChatInteractionCoordinator();
    const ticket = coordinator.begin("history-edit", { sessionId: "session-1" });

    coordinator.invalidate("history-edit", "session-changed");

    expect(coordinator.isCurrent(ticket)).toBe(false);
  });
});
