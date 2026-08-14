// @vitest-environment node

import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { DomainError } from "../core/errors";
import type { AuthService } from "./auth";
import { registerChatRoutes } from "./chat";

const authService = {
  isAuthenticated: vi.fn(async () => true),
} as unknown as AuthService;

describe("Chat 问题答案路由", () => {
  it("严格校验答案并以 202 返回自动启动的下一 Run", async () => {
    const submitQuestionAnswers = vi.fn(async () => ({
      run: {
        runId: "run-2",
        sessionId: "session-1",
        status: "running",
        startedAt: "2026-08-13T00:01:00.000Z",
      },
      resolution: {
        resolutionId: "resolution-1",
        questionRecordId: "record-1",
        status: "submitted",
        answers: [],
        unansweredQuestionIds: ["question-1"],
      },
    }));
    const app = Fastify();
    registerChatRoutes(app, { authService, chatService: { submitQuestionAnswers } as never });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/questions/record-1/answers",
      payload: { version: 1, answers: [], extra: true },
    });
    const valid = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/questions/record-1/answers",
      payload: { version: 1, answers: [] },
    });

    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(202);
    expect(valid.json()).toMatchObject({
      run: { runId: "run-2" },
      resolution: { questionRecordId: "record-1", status: "submitted" },
    });
    expect(submitQuestionAnswers).toHaveBeenCalledWith(
      "session-1",
      "record-1",
      { version: 1, answers: [] },
    );
    await app.close();
  });

  it.each([
    ["QUESTION_NOT_FOUND", 404],
    ["QUESTION_ANSWER_INVALID", 400],
    ["QUESTION_VERSION_CONFLICT", 409],
    ["QUESTION_STATE_CONFLICT", 409],
  ] as const)("把 %s 映射为 %i", async (code, status) => {
    const app = Fastify();
    registerChatRoutes(app, {
      authService,
      chatService: {
        submitQuestionAnswers: vi.fn(async () => { throw new DomainError(code, "失败"); }),
      } as never,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/sessions/session-1/questions/record-1/answers",
      payload: { version: 1, answers: [] },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: { code } });
    await app.close();
  });
});
