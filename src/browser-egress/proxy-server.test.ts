import { describe, expect, it } from "vitest";

import type { BrowserEgressGrant } from "../shared/browser-worker-protocol";
import { issueEgressGrant, readEgressGrant } from "./proxy-server";

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
});
