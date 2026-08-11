// @vitest-environment node

import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  bundledRetrievalSkillContentsForTest,
  cleanupBundledRetrievalSkills,
  type LegacyRetrievalSkillName,
} from "./legacy-retrieval-skills";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("历史内置检索 Skill 清理", () => {
  it("只删除内容完全匹配且目录中只有 SKILL.md 的内置 Skill", async () => {
    const root = await createRoot();
    await writeBundledFixture(root, "knowledge-base");

    const results = await cleanupBundledRetrievalSkills(root);

    expect(results).toContainEqual({ name: "knowledge-base", status: "removed" });
    await expect(access(join(root, "skills", "knowledge-base"))).rejects.toThrow();
  });

  it("保留用户修改的 Skill", async () => {
    const root = await createRoot();
    const directory = join(root, "skills", "knowledge-base");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "user content", "utf8");

    const results = await cleanupBundledRetrievalSkills(root);

    expect(results).toContainEqual({ name: "knowledge-base", status: "preserved_modified" });
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("user content");
  });

  it("目录含额外文件时保留整个目录", async () => {
    const root = await createRoot();
    const directory = await writeBundledFixture(root, "web-research");
    await writeFile(join(directory, "notes.md"), "user", "utf8");

    const results = await cleanupBundledRetrievalSkills(root);

    expect(results).toContainEqual({ name: "web-research", status: "preserved_extra_files" });
    expect(await readFile(join(directory, "notes.md"), "utf8")).toBe("user");
  });

  it("目标不存在时幂等返回 absent", async () => {
    const root = await createRoot();

    await expect(cleanupBundledRetrievalSkills(root)).resolves.toEqual([
      { name: "knowledge-base", status: "absent" },
      { name: "web-research", status: "absent" },
    ]);
  });
});

/** 创建隔离的 Pi 数据根目录。 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-retrieval-skills-"));
  roots.push(root);
  return root;
}

/** 写入最后一版 BugPaw 内置 Skill，供清理行为测试使用。 */
async function writeBundledFixture(root: string, name: LegacyRetrievalSkillName): Promise<string> {
  const directory = join(root, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), bundledRetrievalSkillContentsForTest[name], "utf8");
  return directory;
}
