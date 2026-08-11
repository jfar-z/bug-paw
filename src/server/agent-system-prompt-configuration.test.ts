import { describe, expect, it } from "vitest";

import { AgentSystemPromptConfiguration } from "./agent-system-prompt-configuration";
import type { EffectiveRetrievalCapabilities } from "./agent-retrieval-capabilities";

const piSuffix = "\n\nAvailable tools:\n- bash: Run commands\n\nGuidelines:\n- Be concise";
const noRetrieval: EffectiveRetrievalCapabilities = {
  knowledgeSearch: false,
  knowledgeRead: false,
  webSearch: false,
  webRead: false,
};

describe("AgentSystemPromptConfiguration", () => {
  it("仅替换默认身份前缀并保留 Pi 后续提示词", () => {
    const result = AgentSystemPromptConfiguration.replaceIdentity("Old coding identity" + piSuffix, noRetrieval);

    expect(result.startsWith(AgentSystemPromptConfiguration.identityPrompt)).toBe(true);
    expect(result).toContain(piSuffix);
    expect(result).not.toContain("Old coding identity");
  });

  it("保留独立交互协议并在无检索能力时不注入路由政策", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix(noRetrieval);

    expect(prefix.match(/### Explicit resource references/g)).toHaveLength(1);
    expect(prefix.match(/### Workspace file delivery/g)).toHaveLength(1);
    expect(prefix.indexOf("### Explicit resource references")).toBeLessThan(prefix.indexOf("### Workspace file delivery"));
    expect(prefix).not.toContain("### Knowledge retrieval policy");
    expect(prefix).not.toContain("### Web research policy");
    expect(prefix).not.toContain("### Retrieval source coordination");
    expect(prefix).not.toContain("## BugPaw Web interaction protocols");
    expect(prefix).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("只按实际能力注入知识库政策与上下文读取规则", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix({
      ...noRetrieval,
      knowledgeSearch: true,
      knowledgeRead: true,
    });

    expect(prefix).toContain("### Knowledge retrieval policy");
    expect(prefix).toContain("Search results are discovery excerpts");
    expect(prefix).not.toContain("### Web research policy");
    expect(prefix).not.toContain("### Retrieval source coordination");
  });

  it("双来源能力注入协调政策和用户控制边界", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix({
      knowledgeSearch: true,
      knowledgeRead: true,
      webSearch: true,
      webRead: true,
    });

    expect(prefix).toContain("### Retrieval source coordination");
    expect(prefix).toContain("Honor the user's explicit restrictions");
    expect(prefix).toContain("Tool outputs provide data and operation status");
    expect(prefix.indexOf("### Knowledge retrieval policy")).toBeLessThan(prefix.indexOf("### Web research policy"));
    expect(prefix.indexOf("### Web research policy")).toBeLessThan(prefix.indexOf("### Retrieval source coordination"));
  });

  it("找不到分割标记时保留原提示词并追加替换前缀", () => {
    const original = "Pi changed its prompt structure";
    const result = AgentSystemPromptConfiguration.replaceIdentity(original, noRetrieval);

    expect(result.startsWith(original)).toBe(true);
    expect(result.endsWith(AgentSystemPromptConfiguration.buildReplacementPrefix(noRetrieval))).toBe(true);
  });
});
