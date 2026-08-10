// @vitest-environment node

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPromptStore } from "./agent-prompt-store";
import { createEditOwnPromptsTool } from "./agent-prompt-tool";

describe("edit_own_prompts", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-prompt-tool-"));
    roots.push(root);
    const agentsDir = join(root, "agents");
    await Promise.all([mkdir(join(agentsDir, "agent-a"), { recursive: true }), mkdir(join(agentsDir, "agent-b"), { recursive: true })]);
    const prompts = new AgentPromptStore(agentsDir);
    await Promise.all([prompts.initializeNewAgent("agent-a"), prompts.initializeNewAgent("agent-b")]);
    return { prompts, onUpdated: vi.fn(async () => undefined) };
  }

  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("始终编辑闭包内 Agent 的固定提示词文件", async () => {
    const { prompts, onUpdated } = await fixture();
    const tool = createEditOwnPromptsTool("agent-a", prompts, onUpdated);

    await tool.execute("call", { action: "replace", file: "role", content: "研究助手" }, undefined, undefined, {} as never);

    await expect(prompts.read("agent-a", "role")).resolves.toBe("研究助手");
    await expect(prompts.read("agent-b", "role")).resolves.toBe("");
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it("使用跨 Provider 兼容的顶层对象参数 Schema", async () => {
    const { prompts, onUpdated } = await fixture();
    const tool = createEditOwnPromptsTool("agent-a", prompts, onUpdated);
    const parameters = tool.parameters as unknown as Record<string, unknown>;

    expect(parameters.type).toBe("object");
    expect(parameters).not.toHaveProperty("anyOf");
    expect(parameters).not.toHaveProperty("oneOf");
    expect(parameters).not.toHaveProperty("allOf");
  });

  it("replace 缺少 content 时拒绝修改提示词", async () => {
    const { prompts, onUpdated } = await fixture();
    const tool = createEditOwnPromptsTool("agent-a", prompts, onUpdated);

    const result = await tool.execute(
      "call",
      { action: "replace", file: "role" } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text", text: "replace 操作必须提供 content" });
    await expect(prompts.read("agent-a", "role")).resolves.toBe("");
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it("清空 BOOTSHARP 时返回脱敏状态并触发刷新", async () => {
    const { prompts, onUpdated } = await fixture();
    const tool = createEditOwnPromptsTool("agent-a", prompts, onUpdated);

    const result = await tool.execute("call", { action: "clear", file: "bootsharp" }, undefined, undefined, {} as never);

    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("工具必须返回文本结果");
    expect(content.text).toContain("bootsharp");
    expect(content.text).not.toContain("初始化协作设定");
    await expect(prompts.read("agent-a", "bootsharp")).resolves.toBe("");
  });
});
