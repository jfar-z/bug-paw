// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";

import { createTestDatabase } from "../database/test-database";
import type { Database } from "../database/database";
import { createIdentityRepository } from "./identity-repository";

describe("IdentityRepository", () => {
  const databases: Database[] = [];

  afterEach(() => databases.splice(0).forEach((database) => database.close()));

  it("保存密码摘要和 Web Session，并拒绝重复初始化", async () => {
    const repository = createRepository();
    const user = await repository.initializeUser({
      id: "owner",
      password: { algorithm: "scrypt", salt: "salt", hash: "digest" },
      displayName: "用户",
      now: "2026-08-07T00:00:00.000Z",
    });
    await repository.createWebSession({
      tokenHash: "token-digest",
      userId: user.id,
      createdAt: "2026-08-07T00:00:00.000Z",
      expiresAt: "2026-08-08T00:00:00.000Z",
    });

    expect(await repository.findWebSession("token-digest", "2026-08-07T12:00:00.000Z")).toMatchObject({ userId: "owner" });
    await expect(repository.initializeUser({
      id: "other",
      password: { algorithm: "scrypt", salt: "salt-2", hash: "digest-2" },
      displayName: "其他用户",
      now: "2026-08-07T00:00:00.000Z",
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("过期 Web Session 不再返回并会被清理", async () => {
    const repository = createRepository();
    await repository.initializeUser({
      id: "owner",
      password: { algorithm: "scrypt", salt: "salt", hash: "digest" },
      displayName: "用户",
      now: "2026-08-07T00:00:00.000Z",
    });
    await repository.createWebSession({
      tokenHash: "expired-token",
      userId: "owner",
      createdAt: "2026-08-07T00:00:00.000Z",
      expiresAt: "2026-08-07T01:00:00.000Z",
    });

    expect(await repository.findWebSession("expired-token", "2026-08-07T02:00:00.000Z")).toBeUndefined();
    expect(await repository.deleteExpiredWebSessions("2026-08-07T02:00:00.000Z")).toBe(1);
  });

  it("个人资料更新使用 Revision 防止并发覆盖", async () => {
    const repository = createRepository();
    const created = await repository.initializeUser({
      id: "owner",
      password: { algorithm: "scrypt", salt: "salt", hash: "digest" },
      displayName: "用户",
      now: "2026-08-07T00:00:00.000Z",
    });

    const updated = await repository.updateProfile("owner", created.revision, {
      displayName: "新名称",
      now: "2026-08-07T01:00:00.000Z",
    });

    expect(updated).toMatchObject({ displayName: "新名称", revision: "2" });
    await expect(repository.updateProfile("owner", created.revision, {
      displayName: "过期更新",
      now: "2026-08-07T02:00:00.000Z",
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  function createRepository() {
    const database = createTestDatabase();
    databases.push(database);
    return createIdentityRepository(database);
  }
});
