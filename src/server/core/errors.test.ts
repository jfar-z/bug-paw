import { describe, expect, it } from "vitest";

import { DomainError, toSafePublicMessage } from "./errors";

describe("DomainError", () => {
  it("从 API 错误详情中移除敏感字段并保留可诊断字段", () => {
    const error = new DomainError("VERSION_CONFLICT", "版本冲突", {
      apiKey: "credential",
      authorization: "credential",
      nested: {
        token: "credential",
        expectedRevision: "r2",
      },
    });

    expect(error.toDocument("req-1")).toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "版本冲突",
        requestId: "req-1",
        details: {
          nested: {
            expectedRevision: "r2",
          },
        },
      },
    });
  });

  it("没有安全详情时不输出空 details 字段", () => {
    const error = new DomainError("SESSION_BUSY", "会话正在运行", {
      password: "credential",
    });

    expect(error.toDocument("req-2")).toEqual({
      error: {
        code: "SESSION_BUSY",
        message: "会话正在运行",
        requestId: "req-2",
      },
    });
  });

  it("公开错误消息隐藏凭据、URL 用户信息和绝对路径并限制长度", () => {
    const error = new Error(`Authorization: Bearer secret-value https://user:pass@example.test/v1 /data/private/file ${"x".repeat(500)}`);

    const message = toSafePublicMessage(error, "操作失败");

    expect(message).not.toContain("secret-value");
    expect(message).not.toContain("user:pass");
    expect(message).not.toContain("/data/private/file");
    expect(message.length).toBeLessThanOrEqual(300);
  });
});
