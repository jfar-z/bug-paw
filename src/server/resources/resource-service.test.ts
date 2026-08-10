// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceService } from "./resource-service";

describe("ResourceService", () => {
  const roots: string[] = [];
  afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

  it("返回资源来源、作用域、描述、诊断和扩展工具", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-resources-")); roots.push(root);
    const agentDir = join(root, "agent"); const cwd = join(root, "workspace");
    await mkdir(join(agentDir, "skills", "review"), { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await mkdir(join(cwd, ".pi", "prompts"), { recursive: true });
    await mkdir(join(cwd, ".pi", "skills", "invalid"), { recursive: true });
    await writeFile(join(agentDir, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: 审查代码\n---\n执行审查。\n", "utf8");
    await writeFile(join(cwd, ".pi", "prompts", "brief.md"), "---\nname: brief\ndescription: 生成摘要\n---\n请摘要 $ARGUMENTS\n", "utf8");
    await writeFile(join(cwd, ".pi", "skills", "invalid", "SKILL.md"), "---\nname: Invalid Name\n---\n坏技能\n", "utf8");
    await writeFile(join(agentDir, "extensions", "tool.js"), "export default function(pi){pi.registerTool({name:'danger_tool',label:'Danger',description:'危险操作',parameters:{type:'object',properties:{}},async execute(){return {content:[{type:'text',text:'ok'}],details:{}}}})}\n", "utf8");

    const catalog = await new ResourceService({ agentDir, cwd }).catalog();
    expect(catalog.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "skill", name: "review", description: "审查代码", scope: "global", source: "auto" }),
      expect.objectContaining({ type: "prompt", name: "brief", scope: "agent" }),
      expect.objectContaining({ type: "extension", name: "tool.js", scope: "global" }),
    ]));
    expect(catalog.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "danger_tool", highRisk: true })]));
    expect(catalog.diagnostics.length).toBeGreaterThan(0);
  });
});
