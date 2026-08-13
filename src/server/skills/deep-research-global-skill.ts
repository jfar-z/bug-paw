import { chmod, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEEP_RESEARCH_SKILL_NAME = "deep-research" as const;

export type DeepResearchSkillInstallStatus = "installed" | "current" | "preserved_existing";

export interface DeepResearchSkillInstallResult {
  name: typeof DEEP_RESEARCH_SKILL_NAME;
  status: DeepResearchSkillInstallStatus;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** 读取随服务发布的通用深度研究 Skill 正文。 */
export async function readBundledDeepResearchSkill(): Promise<string> {
  const moduleUrl = new URL(import.meta.url);
  if (moduleUrl.protocol === "file:") {
    return readFile(new URL("./deep-research/SKILL.md", moduleUrl), "utf8");
  }

  // Vitest 的 jsdom 转换会把 import.meta.url 改写为 HTTP URL，测试时回退到源码工作目录。
  return readFile(join(process.cwd(), "src", "server", "skills", "deep-research", "SKILL.md"), "utf8");
}

/**
 * 安装供全部 Pi Agent 发现的通用深度研究 Skill。
 *
 * @param agentDir Pi 全局数据目录
 */
export async function ensureDeepResearchGlobalSkill(agentDir: string): Promise<DeepResearchSkillInstallResult> {
  const skillsDirectory = join(agentDir, "skills");
  const directory = join(skillsDirectory, DEEP_RESEARCH_SKILL_NAME);
  const target = join(directory, "SKILL.md");
  const bundled = await readBundledDeepResearchSkill();

  let skillsMetadata;
  try {
    skillsMetadata = await lstat(skillsDirectory);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
    await mkdir(skillsDirectory, { recursive: true, mode: 0o700 });
    skillsMetadata = await lstat(skillsDirectory);
  }
  if (!skillsMetadata.isDirectory()) {
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "preserved_existing" };
  }

  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(target, bundled, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(directory, 0o700);
    await chmod(target, 0o600);
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "installed" };
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }

  // 符号链接可能指向数据目录之外；所有非普通目录节点都视为用户内容。
  const metadata = await lstat(directory);
  if (!metadata.isDirectory()) {
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "preserved_existing" };
  }

  const entries = await readdir(directory);
  if (entries.length === 0) {
    try {
      await writeFile(target, bundled, { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      return ensureDeepResearchGlobalSkill(agentDir);
    }
    await chmod(directory, 0o700);
    await chmod(target, 0o600);
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "installed" };
  }

  // 同名目录可能由用户维护；出现未知正文或任何额外资源时绝不覆盖。
  if (entries.length !== 1 || entries[0] !== "SKILL.md") {
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "preserved_existing" };
  }

  const targetMetadata = await lstat(target);
  if (!targetMetadata.isFile()) {
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "preserved_existing" };
  }

  const current = await readFile(target, "utf8");
  if (current !== bundled) {
    return { name: DEEP_RESEARCH_SKILL_NAME, status: "preserved_existing" };
  }

  await chmod(directory, 0o700);
  await chmod(target, 0o600);
  return { name: DEEP_RESEARCH_SKILL_NAME, status: "current" };
}
