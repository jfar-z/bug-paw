// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    const bootsharp = await readFile(join(agentsDir, "agent-a", "BOOTSHARP.md"), "utf8");
    expect(bootsharp).toContain("不得使用一级或二级标题（`#`、`##`）");
    expect(bootsharp).toContain("`read`");
    expect(bootsharp).toContain("`write`");
    expect(bootsharp).toContain("空字符串");
    expect(bootsharp).not.toContain("编辑自身提示词");
    expect(bootsharp).not.toContain("edit_own_prompts");
  });

  it("读取存量 Agent 的缺失文件时不创建文件", async () => {
    const { agentsDir, prompts } = await fixture();

    await expect(prompts.read("legacy", "role")).resolves.toBe("");
    await expect(stat(join(agentsDir, "legacy", "ROLE.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("返回提示词目录、五个绝对路径与同一时刻读取的完整内容", async () => {
    const { agentsDir, prompts } = await fixture();
    await prompts.initializeNewAgent("agent-a");
    await prompts.initializeNewAgent("agent-b");
    await Promise.all([
      writeFile(join(agentsDir, "agent-a", "ROLE.md"), "负责代码审查", "utf8"),
      writeFile(join(agentsDir, "agent-a", "BEHAVIOR.md"), "先给结论", "utf8"),
      writeFile(join(agentsDir, "agent-a", "RULES.md"), "改生产前先确认", "utf8"),
      writeFile(join(agentsDir, "agent-a", "USER.md"), "用户偏好中文", "utf8"),
      writeFile(join(agentsDir, "agent-a", "BOOTSHARP.md"), "完成首次设定", "utf8"),
      writeFile(join(agentsDir, "agent-b", "ROLE.md"), "其他 Agent 的角色", "utf8"),
    ]);

    await expect(prompts.readContext("agent-a")).resolves.toEqual({
      directory: join(agentsDir, "agent-a"),
      paths: {
        role: join(agentsDir, "agent-a", "ROLE.md"),
        behavior: join(agentsDir, "agent-a", "BEHAVIOR.md"),
        rules: join(agentsDir, "agent-a", "RULES.md"),
        user: join(agentsDir, "agent-a", "USER.md"),
        bootsharp: join(agentsDir, "agent-a", "BOOTSHARP.md"),
      },
      instructions: {
        role: "负责代码审查",
        behavior: "先给结论",
        rules: "改生产前先确认",
        user: "用户偏好中文",
      },
      bootsharp: "完成首次设定",
    });
    expect(JSON.stringify(await prompts.readContext("agent-a"))).not.toContain("其他 Agent 的角色");
    expect(JSON.stringify(await prompts.readContext("agent-a"))).not.toContain(join(agentsDir, "agent-b"));
    expect((await stat(join(agentsDir, "agent-a", "ROLE.md"))).mode & 0o777).toBe(0o600);
  });

  it("读取存量 Agent 上下文时将缺失文件视为空且不补写", async () => {
    const { agentsDir, prompts } = await fixture();

    const context = await prompts.readContext("legacy");

    expect(context.instructions).toEqual({ role: "", behavior: "", rules: "", user: "" });
    expect(context.bootsharp).toBe("");
    await expect(stat(join(agentsDir, "legacy", "BOOTSHARP.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("上下文读取不会把非缺失文件错误伪装成空内容", async () => {
    const { agentsDir, prompts } = await fixture();
    await mkdir(join(agentsDir, "legacy", "ROLE.md"));

    await expect(prompts.readContext("legacy")).rejects.toMatchObject({ code: "EISDIR" });
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
