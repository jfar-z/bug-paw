import { describe, expect, it } from "vitest";

import type { BrowserEgressGrant } from "../shared/browser-worker-protocol";
import { authorizeProxyTarget } from "./address-policy";

/** 浏览器出口必须在 DNS 解析后执行严格地址判定。 */
describe("浏览器出口地址策略", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.1.1",
    "100.64.0.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
  ])("拒绝非公网地址 %s", async (address) => {
    await expect(authorizeProxyTarget(input("https:", "example.com", 443, [address]))).rejects.toMatchObject({
      code: "BROWSER_PRIVATE_NETWORK_BLOCKED",
    });
  });

  it.each(["169.254.169.254", "fd00:ec2::254"])("云元数据地址即使受信任也拒绝：%s", async (address) => {
    await expect(authorizeProxyTarget(input("http:", address, 80, [address], [`http://${formatHost(address)}`])))
      .rejects.toMatchObject({ code: "BROWSER_PRIVATE_NETWORK_BLOCKED" });
  });

  it("允许全部 DNS 结果均为公网的 HTTPS 目标", async () => {
    await expect(authorizeProxyTarget(input("https:", "example.com", 443, ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])))
      .resolves.toMatchObject({ origin: "https://example.com", address: "93.184.216.34" });
  });

  it("仅在部署侧显式登记后允许 Fake-IP 出口", async () => {
    await expect(authorizeProxyTarget({
      ...input("https:", "example.com", 443, ["198.18.1.127"]),
      trustedFakeIpCidrs: ["198.18.0.0/15"],
    })).resolves.toMatchObject({ origin: "https://example.com", address: "198.18.1.127" });
  });

  it("任一 DNS 结果受限时拒绝整个目标以防重绑定", async () => {
    await expect(authorizeProxyTarget(input("https:", "example.com", 443, ["93.184.216.34", "127.0.0.1"])))
      .rejects.toMatchObject({ code: "BROWSER_PRIVATE_NETWORK_BLOCKED" });
  });

  it("只允许精确受信任 Origin 使用私网 HTTP 例外", async () => {
    await expect(authorizeProxyTarget(input("http:", "ui.local", 8080, ["192.168.1.10"], ["http://ui.local:8080"])))
      .resolves.toMatchObject({ origin: "http://ui.local:8080", address: "192.168.1.10" });
    await expect(authorizeProxyTarget(input("http:", "ui.local", 8081, ["192.168.1.10"], ["http://ui.local:8080"])))
      .rejects.toMatchObject({ code: "BROWSER_PRIVATE_NETWORK_BLOCKED" });
    await expect(authorizeProxyTarget(input("http:", "example.com", 80, ["93.184.216.34"])))
      .rejects.toMatchObject({ code: "BROWSER_PRIVATE_NETWORK_BLOCKED" });
  });
});

/** 创建带注入 DNS 结果的策略输入。 */
function input(protocol: "http:" | "https:", hostname: string, port: number, addresses: string[], trustedOrigins: string[] = []) {
  const grant: BrowserEgressGrant = { leaseId: "lease-a", expiresAt: Date.now() + 60_000, trustedOrigins };
  return {
    protocol,
    hostname,
    port,
    grant,
    lookup: async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 as const : 4 as const })),
  };
}

/** 为 URL Origin 添加 IPv6 方括号。 */
function formatHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}
