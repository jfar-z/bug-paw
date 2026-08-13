// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import type { SessionQuestionRepository } from "./session-question-repository";
import { createAskUserTool } from "./ask-user-tool";

describe("ask_user 工具", () => {
  it("创建带稳定 ID 的待回答记录并终止当前 Run", async () => {
    const createPending = vi.fn((input) => ({
      ...input,
      state: "pending" as const,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    }));
    const tool = createAskUserTool({
      agentId: "agent-1",
      sessionId: "session-1",
      branchAnchorId: () => "entry-1",
      repository: { createPending } as unknown as SessionQuestionRepository,
    });

    const result = await tool.execute("call-1", {
      questions: [{
        header: "方案",
        question: "请选择方案",
        multiSelect: false,
        options: [
          { label: "A", description: "方案 A" },
          { label: "B", description: "方案 B" },
        ],
      }],
    }, undefined, undefined, {} as never);

    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptGuidelines).toHaveLength(2);
    expect(createPending).toHaveBeenCalledOnce();
    expect(createPending.mock.calls[0][0]).toMatchObject({
      agentId: "agent-1",
      sessionId: "session-1",
      toolCallId: "call-1",
      branchAnchorId: "entry-1",
      questions: [{
        header: "方案",
        options: [
          expect.objectContaining({ label: "A" }),
          expect.objectContaining({ label: "B" }),
        ],
      }],
    });
    expect(createPending.mock.calls[0][0].questions[0].id).toEqual(expect.any(String));
    expect(createPending.mock.calls[0][0].questions[0].options[0].id).toEqual(expect.any(String));
    expect(result).toMatchObject({
      isError: false,
      terminate: true,
      details: {
        type: "question_pending",
        pendingQuestion: {
          toolCallId: "call-1",
          version: 1,
        },
      },
    });
  });

  it("直接执行时再次拒绝错误参数且不终止 Run", async () => {
    const createPending = vi.fn();
    const tool = createAskUserTool({
      agentId: "agent-1",
      sessionId: "session-1",
      branchAnchorId: () => undefined,
      repository: { createPending } as unknown as SessionQuestionRepository,
    });

    const result = await tool.execute(
      "call-invalid",
      { questions: [] } as never,
      undefined,
      undefined,
      {} as never,
    );

    expect(createPending).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true });
    expect(result.terminate).toBeUndefined();
  });
});
