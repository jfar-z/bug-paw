import { describe, expect, it } from "vitest";

import { createAgentSystemPromptInjectionExtension } from "./agent-system-prompt-extension";

describe("Agent 系统提示词注入扩展", () => {
  it("在 before_agent_start 中替换完整系统提示词的身份段", async () => {
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | Promise<{ systemPrompt: string }>) | undefined;
    const extension = createAgentSystemPromptInjectionExtension();

    extension.factory({
      on: (_event: string, callback: unknown) => {
        handler = callback as never;
      },
    } as never);

    const result = await handler?.({ systemPrompt: "Old identity\n\nAvailable tools:\n- read" });

    expect(result?.systemPrompt).toContain("You are a versatile work assistant");
    expect(result?.systemPrompt).toContain("Available tools:\n- read");
  });
});
