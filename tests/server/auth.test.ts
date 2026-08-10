// @vitest-environment node

import { describe, expect, it } from "vitest";
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from "../../src/server/auth";
import { sanitizeAppConfig, type StoredAppConfig } from "../../src/server/config";

describe("密码与会话令牌", () => {
  it("只接受与 scrypt 记录匹配的密码", async () => {
    const record = await hashPassword("a-correct-local-password");

    await expect(verifyPassword("a-correct-local-password", record)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", record)).resolves.toBe(false);
    expect(record.algorithm).toBe("scrypt");
    expect(record.hash).not.toContain("a-correct-local-password");
  });

  it("相同密码使用独立随机盐", async () => {
    const first = await hashPassword("same-password");
    const second = await hashPassword("same-password");

    expect(first.salt).not.toBe(second.salt);
    expect(first.hash).not.toBe(second.hash);
  });

  it("只持久化会话令牌的 SHA-256 哈希", () => {
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(tokenHash).not.toContain(token);
  });
});

describe("配置脱敏", () => {
  it("状态响应只暴露初始化状态", () => {
    const config: StoredAppConfig = {
      version: 3,
      createdAt: "2026-08-05T00:00:00.000Z",
      authentication: {
        password: {
          algorithm: "scrypt",
          salt: "salt",
          hash: "password-hash",
        },
      },
      migration: { piConfiguration: "complete" },
      profile: { displayName: "BUG" },
    };

    expect(sanitizeAppConfig(config)).toEqual({
      initialized: true,
    });
  });
});
