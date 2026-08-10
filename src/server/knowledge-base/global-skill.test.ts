// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ensureKnowledgeBaseSkill } from "./global-skill";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("知识库全局 Skill", () => {
  it("说明 Agent 管理知识库的工具与全局删除后果", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-knowledge-skill-"));
    roots.push(root);

    await ensureKnowledgeBaseSkill(root);

    await expect(readFile(join(root, "skills", "knowledge-base", "SKILL.md"), "utf8")).resolves.toEqual(expect.stringContaining("manage_knowledge_base"));
    await expect(readFile(join(root, "skills", "knowledge-base", "SKILL.md"), "utf8")).resolves.toEqual(expect.stringContaining("modify_knowladge_base"));
    await expect(readFile(join(root, "skills", "knowledge-base", "SKILL.md"), "utf8")).resolves.toEqual(expect.stringContaining("action=delete_base"));
    await expect(readFile(join(root, "skills", "knowledge-base", "SKILL.md"), "utf8")).resolves.toEqual(expect.stringContaining("全部 Agent 绑定"));
  });
});
