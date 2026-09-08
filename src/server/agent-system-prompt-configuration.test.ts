// @vitest-environment node

import { describe, expect, it } from "vitest";
import { AgentSystemPromptConfiguration } from "./agent-system-prompt-configuration";

describe("Agent 文件交付提示词", () => {
  it("要求使用普通 Markdown 链接且不为交付重复执行检查命令", () => {
    const prompt = AgentSystemPromptConfiguration.buildReplacementPrefix({
      knowledgeSearch: false,
      knowledgeRead: false,
      webSearch: false,
      webRead: false,
    });

    expect(prompt).toContain("[example.png](outputs/example.png)");
    expect(prompt).toContain("absolute /data paths");
    expect(prompt).toContain("without running shell commands only to verify that it exists");
    expect(prompt).not.toContain("pi_agent_files");
  });
});
