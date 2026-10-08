// @vitest-environment node
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResourceService } from "./resource-service";

/** 用真实 Pi 解析与临时配置验证模式，禁止写入生产资源。 */
describe("资源模式原生配置", () => {
  const roots: string[] = [];
  afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-resource-mode-")); roots.push(root);
    const agentDir = join(root, "global"), cwd = join(root, "agent"), pkg = join(root, "package");
    await mkdir(join(cwd, ".pi"), { recursive: true }); await mkdir(agentDir, { recursive: true });
    await mkdir(join(pkg, "prompts"), { recursive: true });
    await writeFile(join(pkg, "prompts", "one.md"), "示例提示一", "utf8"); await writeFile(join(pkg, "prompts", "two.md"), "示例提示二", "utf8");
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "example-package", version: "0.0.0", pi: { prompts: ["prompts/*.md"] } }), "utf8");
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg], customField: { keep: true } }), "utf8");
    return { root, agentDir, cwd, pkg, global: new ResourceService({ agentDir, cwd: root }), agent: new ResourceService({ agentDir, cwd, target: "agent" }) };
  }
  it("包内资源屏蔽真实生效，其他条目与未知配置保留", async () => {
    const f = await fixture(); const first = (await f.global.catalog()).resources.find((r) => r.path.endsWith("one.md"))!;
    const disabled = await f.global.setMode(first.id, "disabled", "global");
    expect(disabled.resources.find((r) => r.id === first.id)).toMatchObject({ enabled: false, mode: "disabled" });
    expect(disabled.resources.find((r) => r.path.endsWith("two.md"))?.enabled).toBe(true);
    expect(JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")).customField).toEqual({ keep: true });
    expect((await f.global.setMode(first.id, "enabled", "global")).resources.find((r) => r.id === first.id)?.enabled).toBe(true);
  });
  it("Agent 包覆盖复用全局安装目录，恢复继承清理该精确过滤且不重新安装", async () => {
    const f = await fixture(); const first = (await f.agent.catalog()).resources.find((r) => r.path.endsWith("one.md"))!;
    expect(first).toMatchObject({ scope: "global", mode: "inherit" });
    const disabled = await f.agent.setMode(first.id, "disabled", "agent");
    expect(disabled.resources.find((r) => r.id === first.id)).toMatchObject({ enabled: false, scope: "global", mode: "disabled" });
    expect((await f.global.catalog()).resources.find((r) => r.id === first.id)?.enabled).toBe(true);
    const inherited = await f.agent.setMode(first.id, "inherit", "agent");
    expect(inherited.resources.find((r) => r.id === first.id)).toMatchObject({ enabled: true, mode: "inherit" });
    expect(JSON.parse(await readFile(join(f.cwd, ".pi", "settings.json"), "utf8")).packages).toEqual([]);
  });
  it("显式空包过滤保持屏蔽其他资源，只启用目标条目", async () => {
    const f = await fixture(); await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ packages: [{ source: f.pkg, prompts: [], themes: ["keep"] }] }), "utf8");
    const first = (await f.global.catalog()).resources.find((r) => r.path.endsWith("one.md"))!;
    const result = await f.global.setMode(first.id, "enabled", "global");
    expect(result.resources.find((r) => r.id === first.id)?.enabled).toBe(true);
    expect(result.resources.find((r) => r.path.endsWith("two.md"))?.enabled).toBe(false);
    expect(JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")).packages[0].themes).toEqual(["keep"]);
  });
  it("独立全局资源 Agent 覆盖恢复后重新显示全局来源", async () => {
    const f = await fixture();await mkdir(join(f.agentDir, "prompts"), { recursive:true });await writeFile(join(f.agentDir, "prompts", "local.md"), "示例", "utf8");
    const first = (await f.agent.catalog()).resources.find((r) => r.path.endsWith("local.md"))!;
    expect((await f.agent.setMode(first.id, "disabled", "agent")).resources.find((r) => r.id === first.id)).toMatchObject({ enabled:false, scope:"global", mode:"disabled" });
    expect((await f.agent.setMode(first.id, "inherit", "agent")).resources.find((r) => r.id === first.id)).toMatchObject({ enabled:true, scope:"global", mode:"inherit" });
  });
  it("npm 全局包的 Agent 覆盖不依赖项目 npm 安装", async () => {
    const f = await fixture(); const packageRoot = join(f.agentDir, "npm", "node_modules", "example-package");
    await mkdir(join(packageRoot, "prompts"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "example-package", version: "0.0.0", pi: { prompts: ["prompts/*.md"] } }), "utf8");
    await writeFile(join(packageRoot, "prompts", "npm.md"), "虚构 npm 包资源", "utf8");
    await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:example-package@0.0.0"] }), "utf8");
    const item = (await f.agent.catalog()).resources.find((r) => r.path.endsWith("npm.md"))!;
    const disabled = await f.agent.setMode(item.id, "disabled", "agent");
    expect(disabled.resources.find((r) => r.id === item.id)).toMatchObject({ enabled: false, scope: "global", mode: "disabled" });
    expect((await f.agent.setMode(item.id, "inherit", "agent")).resources.find((r) => r.id === item.id)).toMatchObject({ enabled: true, mode: "inherit" });
  });

});
