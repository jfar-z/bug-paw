// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentPromptStore } from "./agent-prompt-store";

describe("AgentPromptStore", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-prompts-"));
    roots.push(root);
    const agentsDir = join(root, "agents");
    await mkdir(join(agentsDir, "agent-a"), { recursive: true });
    await mkdir(join(agentsDir, "legacy"), { recursive: true });
    return { agentsDir, prompts: new AgentPromptStore(agentsDir) };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("为新 Agent 创建带提示词标题层级约束的默认 BOOTSHARP", async () => {
    const { agentsDir, prompts } = await fixture();

    await prompts.initializeNewAgent("agent-a");

    await expect(readFile(join(agentsDir, "agent-a", "ROLE.md"), "utf8")).resolves.toBe("");
    await expect(readFile(join(agentsDir, "agent-a", "BEHAVIOR.md"), "utf8")).resolves.toBe("");
    await expect(readFile(join(agentsDir, "agent-a", "BOOTSHARP.md"), "utf8")).resolves.toContain("不得使用一级或二级标题（`#`、`##`）");
  });

  it("读取存量 Agent 的缺失文件时不创建文件", async () => {
    const { agentsDir, prompts } = await fixture();

    await expect(prompts.read("legacy", "role")).resolves.toBe("");
    await expect(stat(join(agentsDir, "legacy", "ROLE.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("只读写固定文件并支持保留空内容", async () => {
    const { prompts } = await fixture();
    await prompts.initializeNewAgent("agent-a");

    await prompts.replace("agent-a", "user", "称呼用户为小嘉");
    await prompts.clear("agent-a", "user");

    await expect(prompts.read("agent-a", "user")).resolves.toBe("");
    await expect(prompts.replace("agent-a", "unknown" as never, "x")).rejects.toThrow("提示词文件");
  });
});
