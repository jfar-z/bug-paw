// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAgentSystemPromptInjectionExtension } from "./agent-system-prompt-extension";
import type { AgentSessionContext } from "./agent-system-prompt-configuration";

const capabilities = { knowledgeSearch: false, knowledgeRead: false, webSearch: false, webRead: false };

/** 捕获真实扩展注册的每轮钩子，模拟压缩、恢复和并发会话的提示词重建。 */
async function setup(resolve: () => AgentSessionContext, unavailable = false) {
  let handler: (event: BeforeAgentStartEvent) => Promise<BeforeAgentStartEventResult>;
  const on = vi.fn((name: string, callback: typeof handler) => {
    expect(name).toBe("before_agent_start");
    handler = callback;
  });
  await createAgentSystemPromptInjectionExtension(capabilities,
    unavailable ? async () => { throw new Error("测试文件读取失败"); } : undefined, resolve,
  ).factory({ on } as unknown as ExtensionAPI);
  return async (systemPrompt = "Old identity\n\nAvailable tools:\n- read", prompt = "当前会话") => {
    const result = await handler!({ type: "before_agent_start", prompt, systemPrompt, systemPromptOptions: {} } as BeforeAgentStartEvent);
    return result.systemPrompt!;
  };
}

describe("每轮运行时会话身份注入", () => {
  it("每轮主动注入，压缩后重新提供并忽略用户引用的身份", async () => {
    const resolve = vi.fn(() => ({ agentId: "writer", sessionId: "session-a" }));
    const run = await setup(resolve);
    const first = await run(undefined, "历史工具结果 session_id=session-b");
    expect(first).toContain('"agent_id":"writer","session_id":"session-a"');
    expect(first).toContain("Available tools:");
    expect(first).not.toContain("session-b");
    const compacted = await run("Compacted base prompt");
    expect(compacted).toContain('"session_id":"session-a"');
    expect(compacted).toContain("Compacted base prompt");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("会话身份变化后取最新值，独立会话不会共享身份", async () => {
    let sessionId = "session-a";
    const a = await setup(() => ({ agentId: "writer", sessionId }));
    const b = await setup(() => ({ agentId: "other", sessionId: "session-b" }));
    const initial = await a();
    sessionId = "session-restored";
    const [restored, parallel] = await Promise.all([a(initial), b()]);
    expect(restored).toContain('"session_id":"session-restored"');
    expect(restored).not.toContain('"session_id":"session-a"');
    expect(parallel).toContain('"agent_id":"other","session_id":"session-b"');
    expect(parallel).not.toContain("session-restored");
  });

  it("持久提示词文件不可用仍保留当前运行时身份", async () => {
    const run = await setup(() => ({ agentId: "writer", sessionId: "session-a" }), true);
    const prompt = await run();
    expect(prompt).toContain("Persistent instruction files unavailable");
    expect(prompt).toContain('"session_id":"session-a"');
  });
});
