import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import type { BrowserEgressGrant } from "../shared/browser-worker-protocol";
import { createBrowserEgressProxy, issueEgressGrant, readEgressGrant } from "./proxy-server";

/** 出口 Grant 必须可验证、短期有效且不可篡改。 */
describe("浏览器出口 Grant", () => {
  const grant: BrowserEgressGrant = {
    leaseId: "lease-a",
    expiresAt: 1_700_000_060_000,
    trustedOrigins: ["http://ui.local:8080"],
  };

  it("签发并读取未过期 Grant", () => {
    const token = issueEgressGrant(grant, "test-secret");

    expect(readEgressGrant(`Basic ${Buffer.from(`bugpaw:${token}`).toString("base64")}`, "test-secret", 1_700_000_000_000))
      .toEqual(grant);
  });

  it("拒绝缺失、篡改和过期 Grant", () => {
    const token = issueEgressGrant(grant, "test-secret");

    expect(() => readEgressGrant(undefined, "test-secret", 1_700_000_000_000)).toThrow("缺少浏览器出口授权");
    expect(() => readEgressGrant(`Basic ${Buffer.from(`bugpaw:${token}x`).toString("base64")}`, "test-secret", 1_700_000_000_000)).toThrow("浏览器出口授权无效");
    expect(() => readEgressGrant(`Basic ${Buffer.from(`bugpaw:${token}`).toString("base64")}`, "test-secret", grant.expiresAt)).toThrow("浏览器出口授权已过期");
  });

  it("拒绝未知字段和云元数据 Origin", () => {
    expect(() => issueEgressGrant({ ...grant, trustedOrigins: ["http://169.254.169.254"] }, "test-secret"))
      .toThrow("浏览器出口授权包含禁止的 Origin");
    expect(() => issueEgressGrant({ ...grant, extra: true } as BrowserEgressGrant, "test-secret"))
      .toThrow("浏览器出口授权字段无效");
  });

  it("缺少凭证时返回标准 Basic 代理认证挑战", async () => {
    const server = createBrowserEgressProxy({ secret: "test-secret" });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const response = await new Promise<{ status: number; challenge?: string }>((resolve, reject) => {
        const address = server.address() as AddressInfo;
        const outgoing = request({
          hostname: "127.0.0.1",
          port: address.port,
          method: "GET",
          path: "http://example.com/",
        }, (incoming) => {
          incoming.resume();
          resolve({ status: incoming.statusCode ?? 0, challenge: incoming.headers["proxy-authenticate"] });
        });
        outgoing.once("error", reject);
        outgoing.end();
      });
      expect(response).toEqual({ status: 407, challenge: 'Basic realm="BugPaw browser egress"' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
