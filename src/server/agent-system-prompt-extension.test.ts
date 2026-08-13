import { describe, expect, it, vi } from "vitest";

import { createAgentSystemPromptInjectionExtension } from "./agent-system-prompt-extension";
import type { EffectiveRetrievalCapabilities } from "./agent-retrieval-capabilities";

const noRetrieval: EffectiveRetrievalCapabilities = {
  knowledgeSearch: false,
  knowledgeRead: false,
  webSearch: false,
  webRead: false,
};

describe("Agent 系统提示词注入扩展", () => {
  it("在 before_agent_start 中替换完整系统提示词的身份段", async () => {
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | Promise<{ systemPrompt: string }>) | undefined;
    const extension = createAgentSystemPromptInjectionExtension({
      knowledgeSearch: true,
      knowledgeRead: false,
      webSearch: false,
      webRead: false,
    });

    extension.factory({
      on: (_event: string, callback: unknown) => {
        handler = callback as never;
      },
    } as never);

    const result = await handler?.({ systemPrompt: "Old identity\n\nAvailable tools:\n- read" });

    expect(result?.systemPrompt).toContain("You are a versatile work assistant");
    expect(result?.systemPrompt).toContain("Available tools:\n- read");
    expect(result?.systemPrompt).toContain("### Knowledge retrieval policy");
    expect(result?.systemPrompt).not.toContain("### Web research policy");
  });

  it("每轮重新解析提示词文件快照", async () => {
    let handler: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>) | undefined;
    let role = "第一版角色";
    const resolveContext = vi.fn(async () => ({
      directory: "/data/app/agents/agent-a",
      paths: {
        role: "/data/app/agents/agent-a/ROLE.md",
        behavior: "/data/app/agents/agent-a/BEHAVIOR.md",
        rules: "/data/app/agents/agent-a/RULES.md",
        user: "/data/app/agents/agent-a/USER.md",
        bootsharp: "/data/app/agents/agent-a/BOOTSHARP.md",
      },
      instructions: { role, behavior: "", rules: "", user: "" },
      bootsharp: "",
    }));
    const extension = createAgentSystemPromptInjectionExtension(noRetrieval, resolveContext);
    extension.factory({ on: (_event: string, callback: unknown) => { handler = callback as never; } } as never);

    const first = await handler?.({ systemPrompt: "Old\n\nAvailable tools:\n- read" });
    role = "第二版角色";
    const second = await handler?.({ systemPrompt: "Old\n\nAvailable tools:\n- read" });

    expect(first?.systemPrompt).toContain("第一版角色");
    expect(second?.systemPrompt).toContain("第二版角色");
    expect(second?.systemPrompt).not.toContain("第一版角色");
    expect(resolveContext).toHaveBeenCalledTimes(2);
  });

  it("读取失败时仍保留 BugPaw 身份且不泄露错误", async () => {
    let handler: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>) | undefined;
    const resolveContext = vi.fn(async () => {
      throw new Error("EACCES: /data/app/agents/other/ROLE.md");
    });
    const extension = createAgentSystemPromptInjectionExtension(noRetrieval, resolveContext);
    extension.factory({
      on: (_event: string, callback: unknown) => { handler = callback as never; },
    } as never);

    const result = await handler?.({ systemPrompt: "Old\n\nAvailable tools:\n- read" });

    expect(result?.systemPrompt).toContain("You are a versatile work assistant");
    expect(result?.systemPrompt).toContain("persistent instruction files are unavailable");
    expect(result?.systemPrompt).not.toContain("EACCES");
    expect(result?.systemPrompt).not.toContain("/data/app/agents/other");
  });

  it("两个 Agent 的扩展不会交叉注入路径或正文", async () => {
    const snapshot = (agentId: string, role: string) => ({
      directory: `/data/app/agents/${agentId}`,
      paths: {
        role: `/data/app/agents/${agentId}/ROLE.md`,
        behavior: `/data/app/agents/${agentId}/BEHAVIOR.md`,
        rules: `/data/app/agents/${agentId}/RULES.md`,
        user: `/data/app/agents/${agentId}/USER.md`,
        bootsharp: `/data/app/agents/${agentId}/BOOTSHARP.md`,
      },
      instructions: { role, behavior: "", rules: "", user: "" },
      bootsharp: "",
    });
    const render = async (agentId: string, role: string) => {
      let handler: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>) | undefined;
      const extension = createAgentSystemPromptInjectionExtension(
        noRetrieval,
        async () => snapshot(agentId, role),
      );
      extension.factory({
        on: (_event: string, callback: unknown) => { handler = callback as never; },
      } as never);
      return handler?.({ systemPrompt: "Old\n\nAvailable tools:\n- read" });
    };

    const [left, right] = await Promise.all([
      render("agent-a", "甲角色"),
      render("agent-b", "乙角色"),
    ]);

    expect(left?.systemPrompt).toContain("/data/app/agents/agent-a/ROLE.md");
    expect(left?.systemPrompt).toContain("甲角色");
    expect(left?.systemPrompt).not.toContain("agent-b");
    expect(left?.systemPrompt).not.toContain("乙角色");
    expect(right?.systemPrompt).toContain("/data/app/agents/agent-b/ROLE.md");
    expect(right?.systemPrompt).toContain("乙角色");
    expect(right?.systemPrompt).not.toContain("agent-a");
    expect(right?.systemPrompt).not.toContain("甲角色");
  });
});
