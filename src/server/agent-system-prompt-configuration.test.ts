import { describe, expect, it } from "vitest";

import { AgentSystemPromptConfiguration } from "./agent-system-prompt-configuration";

const piSuffix = "\n\nAvailable tools:\n- bash: Run commands\n\nGuidelines:\n- Be concise";

describe("AgentSystemPromptConfiguration", () => {
  it("仅替换默认身份前缀并保留 Pi 后续提示词", () => {
    const result = AgentSystemPromptConfiguration.replaceIdentity("Old coding identity" + piSuffix);

    expect(result.startsWith(AgentSystemPromptConfiguration.identityPrompt)).toBe(true);
    expect(result).toContain(piSuffix);
    expect(result).not.toContain("Old coding identity");
  });

  it("以固定顺序注入一次英文 Web 文件交互协议", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix();

    expect(prefix.match(/### Explicit resource references/g)).toHaveLength(1);
    expect(prefix.match(/### Workspace file delivery/g)).toHaveLength(1);
    expect(prefix.indexOf("### Explicit resource references")).toBeLessThan(prefix.indexOf("### Workspace file delivery"));
    expect(prefix).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("找不到分割标记时保留原提示词并追加替换前缀", () => {
    const original = "Pi changed its prompt structure";
    const result = AgentSystemPromptConfiguration.replaceIdentity(original);

    expect(result.startsWith(original)).toBe(true);
    expect(result.endsWith(AgentSystemPromptConfiguration.buildReplacementPrefix())).toBe(true);
  });
});
