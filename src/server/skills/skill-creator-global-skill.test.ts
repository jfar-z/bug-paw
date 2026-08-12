// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSkillCreatorGlobalSkill } from "./skill-creator-global-skill";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("技能创建助手全局 Skill", () => {
  it("要求在审阅后确认全局或当前 Agent 安装目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-skill-creator-"));
    temporaryRoots.push(root);

    await ensureSkillCreatorGlobalSkill(root);

    const content = await readFile(join(root, "skills", "skill-creator", "SKILL.md"), "utf8");
    expect(content).toContain("name: skill-creator");
    expect(content).toContain("description:");
    expect(content).toContain("临时目录");
    expect(content).toContain("审阅");
    expect(content).toContain("必须询问用户");
    expect(content).toContain("/data/pi/skills/<技能名>");
    expect(content).toContain("<当前 Agent 工作目录>/.pi/skills/<技能名>");
    expect(content).not.toContain("/data/workspace/agents/<agentId>");
    expect(content).not.toContain("agents/");
  });
});
