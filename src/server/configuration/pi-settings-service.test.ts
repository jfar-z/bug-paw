// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PiSettingsService } from "./pi-settings-service";

describe("PiSettingsService", () => {
  const roots: string[] = [];

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-settings-service-"));
    roots.push(root);
    const agentDir = join(root, "pi");
    const cwd = join(root, "workspace", "agent-a");
    const projectFile = join(cwd, ".pi", "settings.json");
    await writeFile(
      join(root, "placeholder"),
      "",
      "utf8",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    return { root, agentDir, cwd, projectFile, globalFile: join(agentDir, "settings.json") };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("深度合并全局与 Agent 重试设置且不公开 TUI 字段", async () => {
    const files = await fixture();
    await writeFile(files.globalFile, '{"retry":{"provider":{"timeoutMs":30000}},"theme":"dark"}\n', "utf8");
    await writeFile(files.projectFile, '{"retry":{"maxRetries":5}}\n', "utf8");
    const service = new PiSettingsService(files);

    const document = await service.read("agent");

    expect(document.own).toEqual({ retry: { maxRetries: 5 } });
    expect(document.inherited).toEqual({ retry: { provider: { timeoutMs: 30000 } } });
    expect(document.effective).toEqual({ retry: { maxRetries: 5, provider: { timeoutMs: 30000 } } });
    expect(JSON.stringify(document)).not.toContain("theme");
  });

  it("读取全局压缩设置时保留 Token 数值", async () => {
    const files = await fixture();
    await writeFile(files.globalFile, JSON.stringify({
      compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
      branchSummary: { reserveTokens: 8_192 },
    }), "utf8");
    const service = new PiSettingsService(files);

    const document = await service.read("global");

    expect(document.own).toEqual({
      compaction: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
      branchSummary: { reserveTokens: 8_192 },
    });
  });

  it("恢复继承只删除 Agent 字段并保留 Pi 未知字段", async () => {
    const files = await fixture();
    await writeFile(files.globalFile, '{"retry":{"provider":{"timeoutMs":30000}}}\n', "utf8");
    await writeFile(files.projectFile, '{"retry":{"maxRetries":5},"futurePiField":{"enabled":true}}\n', "utf8");
    const service = new PiSettingsService(files);
    const loaded = await service.read("agent");

    const updated = await service.update("agent", { inherit: ["retry.maxRetries"] }, loaded.revision);

    expect(updated.own).toEqual({});
    expect(updated.effective).toEqual({ retry: { provider: { timeoutMs: 30000 } } });
    expect(JSON.parse(await readFile(files.projectFile, "utf8"))).toEqual({ futurePiField: { enabled: true } });
  });

  it("拒绝在 Agent 作用域设置全局专属字段", async () => {
    const files = await fixture();
    const service = new PiSettingsService(files);
    const loaded = await service.read("agent");

    await expect(
      service.update("agent", { set: { httpProxy: "http://proxy.invalid" } }, loaded.revision),
    ).rejects.toThrow("全局");
  });

  it("代理与资源 URL 中的凭证只返回占位且回写不覆盖", async () => {
    const files = await fixture();
    const proxy = "http://user:proxy-password@proxy.test:8080";
    const packageUrl = "https://packages.test/resource.git?token=package-secret";
    await writeFile(files.globalFile, JSON.stringify({ httpProxy: proxy, packages: [packageUrl] }), "utf8");
    const service = new PiSettingsService(files);

    const loaded = await service.read("global");
    expect(JSON.stringify(loaded)).not.toMatch(/proxy-password|package-secret/u);
    expect(loaded.own).toMatchObject({ httpProxy: "[REDACTED]", packages: ["[REDACTED]"] });

    await service.update("global", { set: loaded.own }, loaded.revision);
    expect(JSON.parse(await readFile(files.globalFile, "utf8"))).toEqual({ httpProxy: proxy, packages: [packageUrl] });
  });
});
