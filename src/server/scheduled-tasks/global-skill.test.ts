// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureScheduledTaskSkill } from "./global-skill";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("定时任务全局 Skill", () => {
  it("提供可执行的操作、调度和会话目标说明", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-scheduled-skill-"));
    temporaryRoots.push(root);

    await ensureScheduledTaskSkill(root);

    const content = await readFile(join(root, "skills", "scheduled-tasks", "SKILL.md"), "utf8");
    expect(content).toContain("## 操作原则");
    expect(content).toContain("## 调度格式");
    expect(content).toContain("## 目标会话与执行行为");
    expect(content).toContain("action: list");
    expect(content).toContain("IANA 时区");
    expect(content).toContain("new_session");
    expect(content).toContain("existing_session");
  });
});
