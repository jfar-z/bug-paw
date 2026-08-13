import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { DomainError } from "../core/errors";
import { registerApiErrorHandler, statusForDomainError } from "./error-handler";

describe("统一 API 错误处理", () => {
  it("返回领域错误的稳定错误码、请求 ID 和脱敏详情", async () => {
    const app = Fastify();
    registerApiErrorHandler(app);
    app.get("/api/v1/conflict", async () => {
      throw new DomainError("VERSION_CONFLICT", "版本冲突", {
        expectedRevision: "2",
        apiKey: "never-return-this",
      });
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/conflict" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: "VERSION_CONFLICT",
        message: "版本冲突",
        requestId: response.headers["x-request-id"],
        details: { expectedRevision: "2" },
      },
    });
    await app.close();
  });

  it("不向客户端暴露未知异常内容", async () => {
    const app = Fastify();
    registerApiErrorHandler(app);
    app.get("/api/v1/failure", async () => {
      throw new Error("contains-secret-value");
    });

    const response = await app.inject({ method: "GET", url: "/api/v1/failure" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("contains-secret-value");
    expect(response.json()).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        requestId: expect.any(String),
      },
    });
    await app.close();
  });

  it.each([
    ["QUESTION_NOT_FOUND", 404],
    ["QUESTION_ANSWER_INVALID", 400],
    ["QUESTION_VERSION_CONFLICT", 409],
    ["QUESTION_STATE_CONFLICT", 409],
    ["QUESTION_BRANCH_CHANGED", 409],
    ["SESSION_AWAITING_USER", 409],
  ] as const)("问题错误 %s 使用稳定 HTTP 状态", (code, status) => {
    expect(statusForDomainError(code)).toBe(status);
  });
});
