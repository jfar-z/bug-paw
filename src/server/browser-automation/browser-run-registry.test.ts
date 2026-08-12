import { describe, expect, it } from "vitest";

import { BrowserRunRegistry } from "./browser-run-registry";

/** 浏览器工具身份只能来自 Runtime 建立的可信 Run 映射。 */
describe("浏览器 Run Registry", () => {
  it("按 Session 绑定并在 Run 结束后移除可信身份", () => {
    const registry = new BrowserRunRegistry();
    registry.begin({ agentId: "agent-a", sessionId: "session-a", runId: "run-a", cwd: "/workspace/agent-a" });

    expect(registry.requireCurrent("session-a")).toEqual({
      agentId: "agent-a",
      sessionId: "session-a",
      runId: "run-a",
      cwd: "/workspace/agent-a",
    });
    expect(registry.end("session-a", "other-run")).toBe(false);
    expect(registry.end("session-a", "run-a")).toBe(true);
    expect(() => registry.requireCurrent("session-a")).toThrow("当前会话没有活动的浏览器 Run");
  });

  it("拒绝覆盖同一 Session 的活动 Run", () => {
    const registry = new BrowserRunRegistry();
    registry.begin({ agentId: "agent-a", sessionId: "session-a", runId: "run-a", cwd: "/workspace/agent-a" });

    expect(() => registry.begin({ agentId: "agent-a", sessionId: "session-a", runId: "run-b", cwd: "/workspace/agent-a" }))
      .toThrow("会话已经绑定活动的浏览器 Run");
  });
});
