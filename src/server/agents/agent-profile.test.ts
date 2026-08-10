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
      "search_knowledge",
      "get_knowledge_document",
      "manage_knowledge_base",
      "scheduled_tasks",
      "edit_own_prompts",
    ]));
  });

  it("新建 Agent 保留语音回答配置", () => {
    const profile = createAgentProfile("agent-1", "/data/workspace/agents/agent-1", {
      name: "语音 Agent",
      ttsProfileId: "voice-a",
      ttsVoice: "Cherry",
      ttsAutoPlay: true,
      ttsStreamPlayback: true,
    }, "2026-08-07T00:00:00.000Z");

    expect(profile).toMatchObject({ ttsProfileId: "voice-a", ttsVoice: "Cherry", ttsAutoPlay: true, ttsStreamPlayback: true });
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
