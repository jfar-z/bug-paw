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
    expect(prefix).toContain("Read the relevant document context");
    expect(prefix).not.toContain("### Web research policy");
    expect(prefix).not.toContain("### Retrieval source coordination");
  });

  it("知识库读取可用时按证据完整性主动读取上下文", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix({
      ...noRetrieval,
      knowledgeSearch: true,
      knowledgeRead: true,
    });

    expect(prefix).toContain("completely and unambiguously");
    expect(prefix).toContain("supports the narrow claim");
    expect(prefix).toContain("without waiting for the user to ask");
    expect(prefix).toContain("summary or conclusion depends");
    expect(prefix).toContain("on surrounding text");
  });

  it("联网搜索与读取同时可用时禁止只根据摘要回答事实问题", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix({
      ...noRetrieval,
      webSearch: true,
      webRead: true,
    });

    expect(prefix).toContain("Do not answer a factual question from web-search snippets alone");
    expect(prefix).toContain("without waiting for the user to ask");
    expect(prefix).toContain("prefer and read a primary or official source");
    expect(prefix).toContain("candidate links or a search-results list");
  });

  it("只有联网搜索时不声称能够读取页面", () => {
    const prefix = AgentSystemPromptConfiguration.buildReplacementPrefix({
      ...noRetrieval,
      webSearch: true,
    });

    expect(prefix).toContain("Search results and snippets are discovery aids");
    expect(prefix).not.toContain("read at least one relevant source");
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
