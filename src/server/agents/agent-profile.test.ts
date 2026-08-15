// @vitest-environment node

import { describe, expect, it } from "vitest";

import { createAgentProfile } from "./agent-profile";

describe("createAgentProfile", () => {
  it("新建 Agent 默认启用内置与系统工具", () => {
    const profile = createAgentProfile("agent-1", "/data/workspace/agents/agent-1", { name: "新 Agent" }, "2026-08-07T00:00:00.000Z");

    expect(profile.allowedTools).toEqual(expect.arrayContaining([
      "read",
      "bash",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "session_list",
      "session_search",
      "session_read",
      "knowledge_search",
      "knowledge_read",
      "knowledge_manage",
      "scheduled_tasks",
      "web_search",
      "web_read",
    ]));
    expect(profile.allowedTools).not.toContain("edit_own_prompts");
    expect(profile.allowedTools).not.toEqual(expect.arrayContaining([
      "search_knowledge",
      "get_knowledge_document",
      "manage_knowledge_base",
      "web_open",
    ]));
  });

  it("新建 Agent 保留语音回答配置", () => {
    const profile = createAgentProfile("agent-1", "/data/workspace/agents/agent-1", {
      name: "语音 Agent",
      ttsProfileId: "voice-a",
      ttsVoice: "Cherry",
      ttsCustomParameters: { instructions: "温柔", response_format: "pcm" },
      ttsAutoPlay: true,
      ttsStreamPlayback: true,
    }, "2026-08-07T00:00:00.000Z");

    expect(profile).toMatchObject({
      ttsProfileId: "voice-a",
      ttsVoice: "Cherry",
      ttsCustomParameters: { instructions: "温柔", response_format: "pcm" },
      ttsAutoPlay: true,
      ttsStreamPlayback: true,
    });
  });

  it("未选择语音模型时不保留孤立的自定义参数", () => {
    const profile = createAgentProfile("agent-1", "/data/workspace/agents/agent-1", {
      name: "无语音 Agent",
      ttsCustomParameters: { instructions: "不会生效" },
    }, "2026-08-14T00:00:00.000Z");

    expect(profile).not.toHaveProperty("ttsCustomParameters");
  });

  it("新建 Agent 保留标题生成策略", () => {
    const profile = createAgentProfile("agent-1", "/data/workspace/agents/agent-1", {
      name: "标题 Agent",
      titleGeneration: {
        modelSource: "custom",
        model: { provider: "OpenAI", id: "gpt-title" },
        thinkingEnabled: true,
      },
    }, "2026-08-10T00:00:00.000Z");

    expect(profile.titleGeneration).toEqual({
      modelSource: "custom",
      model: { provider: "OpenAI", id: "gpt-title" },
      thinkingEnabled: true,
    });
  });
});
