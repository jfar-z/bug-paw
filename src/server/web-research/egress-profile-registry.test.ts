import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { EgressProfileRegistry } from "./egress-profile-registry";

describe("联网出口配置档注册表", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("仅向调用方公开不含代理和网段的配置档摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "web-research-egress-"));
    roots.push(root);
    const filePath = join(root, "profiles.json");
    await writeFile(filePath, JSON.stringify({ profiles: [
      { id: "trusted-fake-ip", label: "受信任 Fake-IP DNS", kind: "fake-ip", fakeIpCidrs: ["198.18.0.0/15"] },
      { id: "company-proxy", label: "公司代理", kind: "http-proxy", proxyUrl: "http://user:password@proxy.example:8080" },
    ] }), "utf8");

    const registry = new EgressProfileRegistry(filePath);

    await expect(registry.listSummaries()).resolves.toEqual([
      { id: "direct", label: "直接访问", kind: "direct", available: true },
      { id: "trusted-fake-ip", label: "受信任 Fake-IP DNS", kind: "fake-ip", available: true },
      { id: "company-proxy", label: "公司代理", kind: "http-proxy", available: true },
    ]);
    await expect(registry.require("missing")).rejects.toMatchObject({ code: "WEB_EGRESS_PROFILE_UNAVAILABLE" });
  });

  it("从启动环境变量加载受信任 Fake-IP 网段", async () => {
    const registry = new EgressProfileRegistry(undefined, "198.18.0.0/15, 203.0.113.0/24");

    await expect(registry.require("trusted-fake-ip")).resolves.toEqual({
      id: "trusted-fake-ip",
      label: "受信任 Fake-IP DNS",
      kind: "fake-ip",
      fakeIpCidrs: ["198.18.0.0/15", "203.0.113.0/24"],
    });
  });
});
