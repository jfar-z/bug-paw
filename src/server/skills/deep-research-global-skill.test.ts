// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDeepResearchGlobalSkill,
  readBundledDeepResearchSkill,
} from "./deep-research-global-skill";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-deep-research-"));
  temporaryRoots.push(root);
  return root;
}

describe("通用深度研究全局 Skill", () => {
  it("首次安装后可幂等识别当前内置版本并修复权限", async () => {
    const root = await createRoot();

    await expect(ensureDeepResearchGlobalSkill(root)).resolves.toEqual({
      name: "deep-research",
      status: "installed",
    });

    const directory = join(root, "skills", "deep-research");
    const target = join(directory, "SKILL.md");
    const content = await readFile(target, "utf8");
    expect(content).toBe(await readBundledDeepResearchSkill());
    expect(content).toContain("让下一轮检索由上一轮证据决定");
    expect(content).toContain("禁止证据升级");
    expect(content).toContain("独立证据按证据生成过程计算，不按 URL 数量计算");
    expect(content).toContain("Entity + Version + Date + Claim");
    expect(content).toContain("解决剩余未知会显著改变主结论吗");

    await expect(ensureDeepResearchGlobalSkill(root)).resolves.toEqual({
      name: "deep-research",
      status: "current",
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("可以在已存在的空技能目录中首次安装", async () => {
    const root = await createRoot();
    await mkdir(join(root, "skills", "deep-research"), { recursive: true });

    await expect(ensureDeepResearchGlobalSkill(root)).resolves.toEqual({
      name: "deep-research",
      status: "installed",
    });
  });

  it("保留同名用户 Skill 和额外资源", async () => {
    const root = await createRoot();
    const directory = join(root, "skills", "deep-research");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), "user skill", "utf8");
    await writeFile(join(directory, "notes.md"), "user notes", "utf8");

    await expect(ensureDeepResearchGlobalSkill(root)).resolves.toEqual({
      name: "deep-research",
      status: "preserved_existing",
    });
    expect(await readFile(join(directory, "SKILL.md"), "utf8")).toBe("user skill");
    expect(await readFile(join(directory, "notes.md"), "utf8")).toBe("user notes");
  });

  it("即使正文相同也保留额外资源，不把目录误判为内置版本", async () => {
    const root = await createRoot();
    const directory = join(root, "skills", "deep-research");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), await readBundledDeepResearchSkill(), "utf8");
    await writeFile(join(directory, "reference.md"), "user reference", "utf8");

    await expect(ensureDeepResearchGlobalSkill(root)).resolves.toEqual({
      name: "deep-research",
      status: "preserved_existing",
    });
    expect(await readFile(join(directory, "reference.md"), "utf8")).toBe("user reference");
  });

  it("保留占用技能目录路径的普通文件", async () => {
    const root = await createRoot();
    const target = join(root, "skills", "deep-research");
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(target, "user file", "utf8");

    await expect(ensureDeepResearchGlobalSkill(root)).resolves.toEqual({
      name: "deep-research",
      status: "preserved_existing",
    });
    expect(await readFile(target, "utf8")).toBe("user file");
  });
});
