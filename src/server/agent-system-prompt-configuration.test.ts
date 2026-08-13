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
const promptContext = {
  agentPrompts: {
    directory: "/data/app/agents/agent-a",
    paths: {
      role: "/data/app/agents/agent-a/ROLE.md",
      behavior: "/data/app/agents/agent-a/BEHAVIOR.md",
      rules: "/data/app/agents/agent-a/RULES.md",
      user: "/data/app/agents/agent-a/USER.md",
      bootsharp: "/data/app/agents/agent-a/BOOTSHARP.md",
    },
    instructions: {
      role: "研究助手",
      behavior: "回答简洁",
      rules: "发布前确认",
      user: "称呼用户为小嘉",
    },
    bootsharp: "逐步确认协作方式",
  },
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

  it("注入当前 Agent 的精确路径、四段轻量维护提示和最新内容", () => {
    const result = AgentSystemPromptConfiguration.replaceIdentity(
      "Old identity" + piSuffix,
      noRetrieval,
      promptContext,
    );

    expect(result).toContain("### Your persistent instruction files");
    expect(result).toContain("Directory: `/data/app/agents/agent-a`");
    expect(result).toContain("ROLE.md (`/data/app/agents/agent-a/ROLE.md`)");
    expect(result).toContain("lasting change to who you should be");
    expect(result).toContain("lasting change in how you should work");
    expect(result).toContain("Do not store one-off task instructions");
    expect(result).toContain("asks you to remember such information");
    expect(result).toContain("Never store credentials, secrets");
    expect(result).toContain("do not repeat them in ordinary user-facing responses");
    expect(result).toContain("#### Role and responsibilities\n\n研究助手");
    expect(result).toContain("#### Behavior and collaboration style\n\n回答简洁");
    expect(result).toContain("#### Rules\n\n发布前确认");
    expect(result).toContain("#### User context\n\n称呼用户为小嘉");
    expect(result).toContain("### Initialization guidance\n\n逐步确认协作方式");
    expect(result).toContain(piSuffix);
    expect(result.indexOf("### Workspace file delivery"))
      .toBeLessThan(result.indexOf("### Your persistent instruction files"));
  });

  it("BOOTSHARP 为空时保留路径说明但不注入初始化正文", () => {
    const context = {
      agentPrompts: { ...promptContext.agentPrompts, bootsharp: "" },
    };
    const result = AgentSystemPromptConfiguration.buildReplacementPrefix(noRetrieval, context);

    expect(result).toContain("BOOTSHARP.md (`/data/app/agents/agent-a/BOOTSHARP.md`)");
    expect(result).not.toContain("### Initialization guidance");
  });

  it("上下文读取失败时禁止覆盖文件且不暴露异常", () => {
    const result = AgentSystemPromptConfiguration.buildReplacementPrefix(noRetrieval, {
      agentPromptsUnavailable: true,
    });

    expect(result).toContain("persistent instruction files are unavailable");
    expect(result).toContain("do not read, create, overwrite, or edit them in this turn");
    expect(result).not.toContain("EACCES");
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
    expect(prefix).toContain("SEARCH_PROVIDERS_UNAVAILABLE");
    expect(prefix).toMatch(/do not retry web_search or\s+rewrite the query in the same run/u);
    expect(prefix).toMatch(/Other\s+authorized tools remain available within the user's original scope/u);
    expect(prefix).not.toContain("continue only with evidence already available");
    expect(prefix).not.toContain("temporary limitation");
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
