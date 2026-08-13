import { randomUUID } from "node:crypto";

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";

import {
  AskUserParametersSchema,
  type AskUserParameters,
  type PendingQuestionProjection,
} from "../../shared/session-question-contracts";
import type { SessionQuestionRepository } from "./session-question-repository";

interface AskUserToolContext {
  agentId: string;
  sessionId: string;
  branchAnchorId(): string | undefined;
  repository: SessionQuestionRepository;
}

interface AskUserToolDetails {
  type: "question_pending" | "question_error";
  pendingQuestion?: PendingQuestionProjection;
}

/** 创建严格持久化、成功后终止当前 Run 的 ask_user 工具。 */
export function createAskUserTool(context: AskUserToolContext) {
  return defineTool<typeof AskUserParametersSchema, AskUserToolDetails>({
    name: "ask_user",
    label: "询问用户",
    description: "向用户提交一至四个结构化问题，并等待用户回答后再继续。",
    promptSnippet: "向用户提交 1 至 4 个结构化问题并结束当前 Run",
    promptGuidelines: [
      "仅在缺少用户决策或资料时调用 ask_user。",
      "ask_user 必须是本次响应唯一需要执行的工具，调用后不要继续输出文本。",
    ],
    parameters: AskUserParametersSchema,
    executionMode: "sequential",
    async execute(toolCallId, params) {
      if (!Check(AskUserParametersSchema, params)) {
        return errorResult("提问参数不符合约束");
      }

      try {
        const pending = createPendingProjection(context, toolCallId, params);
        return {
          content: [{ type: "text", text: "已向用户提问，等待用户回答。" }],
          details: { type: "question_pending", pendingQuestion: pending },
          isError: false,
          terminate: true,
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : "无法创建待回答问题");
      }
    },
  });
}

function createPendingProjection(
  context: AskUserToolContext,
  toolCallId: string,
  params: AskUserParameters,
): PendingQuestionProjection {
  const now = new Date().toISOString();
  const record = context.repository.createPending({
    id: randomUUID(),
    agentId: context.agentId,
    sessionId: context.sessionId,
    toolCallId,
    branchAnchorId: context.branchAnchorId(),
    questions: params.questions.map((question) => ({
      id: randomUUID(),
      ...question,
      options: question.options.map((option) => ({ id: randomUUID(), ...option })),
    })),
    now,
  });
  return {
    id: record.id,
    version: record.version,
    toolCallId: record.toolCallId,
    questions: record.questions,
    createdAt: record.createdAt,
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { type: "question_error" as const },
    isError: true,
  };
}
