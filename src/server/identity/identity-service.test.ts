// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { hashPassword, hashSessionToken } from "../auth";
import type { Database } from "../database/database";
import { createTestDatabase } from "../database/test-database";
import { createIdentityRepository } from "./identity-repository";
import { createIdentityService, LoginFailureTracker } from "./identity-service";

describe("IdentityService", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("登录后只通过 Token 摘要认证并支持退出", async () => {
    const { repository, service } = await fixture();
    const result = await service.login("correct-local-password", "client-1");
    expect(result.status).toBe("authenticated");
    if (result.status !== "authenticated") throw new Error("登录未成功");

    expect(await service.authenticateToken(result.token)).toBe(true);
    expect(await repository.findWebSession(hashSessionToken(result.token), "2026-08-07T08:00:00.000Z")).toBeDefined();
    await service.logout(result.token);
    expect(await service.authenticateToken(result.token)).toBe(false);
  });

  it("同一客户端连续五次失败后在窗口内限流", async () => {
    const { service } = await fixture();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login("incorrect", "client-1")).resolves.toEqual({ status: "invalid" });
    }

    await expect(service.login("correct-local-password", "client-1")).resolves.toEqual({ status: "rate_limited" });
  });

  it("伪造大量客户端标识时失败窗口保持固定容量", () => {
    const tracker = new LoginFailureTracker(2);
    tracker.record("client-1", 1);
    tracker.record("client-2", 1);
    tracker.record("client-3", 1);

    expect(tracker.size).toBe(2);
    expect(tracker.isRateLimited("client-1", 2)).toBe(false);
  });

  async function fixture() {
    const database = createTestDatabase();
    databases.push(database);
    const repository = createIdentityRepository(database);
    await repository.initializeUser({
      id: "owner",
      password: await hashPassword("correct-local-password"),
      displayName: "本地管理员",
      now: "2026-08-07T08:00:00.000Z",
    });
    return {
      repository,
      service: createIdentityService(repository, { now: () => new Date("2026-08-07T08:00:00.000Z") }),
    };
  }
});
