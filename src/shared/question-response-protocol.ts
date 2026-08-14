import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import {
  SubmittedQuestionAnswerSchema,
  type PendingQuestionProjection,
} from "./session-question-contracts";

/** 创建不允许额外字段的对象 Schema。 */
function strictObject<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

const SharedResolutionProperties = {
  resolutionId: Type.String({ minLength: 1 }),
  questionRecordId: Type.String({ minLength: 1 }),
  answers: Type.Array(SubmittedQuestionAnswerSchema, { maxItems: 4 }),
  unansweredQuestionIds: Type.Array(Type.String({ minLength: 1 }), {
    maxItems: 4,
    uniqueItems: true,
  }),
};

/** 用户提交答案后的内部解析记录。 */
const SubmittedQuestionResolutionSchema = strictObject({
  ...SharedResolutionProperties,
  status: Type.Literal("submitted"),
});

/** 用户以新消息或分支切换放弃问题后的内部解析记录。 */
const DiscardedQuestionResolutionSchema = strictObject({
  ...SharedResolutionProperties,
  status: Type.Literal("discarded"),
  discardReason: Type.Union([
    Type.Literal("new_message"),
    Type.Literal("branch_changed"),
    Type.Literal("orphaned"),
  ]),
});

export const QuestionResolutionSchema = Type.Union([
  SubmittedQuestionResolutionSchema,
  DiscardedQuestionResolutionSchema,
]);

export type QuestionResolution = Static<typeof QuestionResolutionSchema>;

const ResolvedOptionSchema = strictObject({
  optionId: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 500 }),
});

const ResolvedOptionsAnswerSchema = strictObject({
  questionId: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1, maxLength: 1_000 }),
  kind: Type.Literal("options"),
  options: Type.Array(ResolvedOptionSchema, { minItems: 1, maxItems: 4 }),
});

const ResolvedTextAnswerSchema = strictObject({
  questionId: Type.String({ minLength: 1 }),
  question: Type.String({ minLength: 1, maxLength: 1_000 }),
  kind: Type.Literal("text"),
  text: Type.String({ minLength: 1, maxLength: 10_000 }),
});

const ResolvedQuestionAnswerSchema = Type.Union([
  ResolvedOptionsAnswerSchema,
  ResolvedTextAnswerSchema,
]);

const QuestionResponseEnvelopeV2Schema = strictObject({
  resolution: QuestionResolutionSchema,
  resolvedAnswers: Type.Array(ResolvedQuestionAnswerSchema, { maxItems: 4 }),
});

type QuestionResponseEnvelopeV2 = Static<typeof QuestionResponseEnvelopeV2Schema>;

export interface ParsedQuestionResponseProtocol {
  resolution?: QuestionResolution;
  visibleText: string;
}

const PROTOCOL_PATTERN = /^<bug_paw_question_response version="([12])">\n([\s\S]*?)\n<\/bug_paw_question_response>(?:\n\n([\s\S]*))?$/u;

/** 避免用户文本提前闭合内部协议标签。 */
function escapeProtocolJson(json: string): string {
  return json.replace(/[<>&]/gu, (character) => {
    if (character === "<") {
      return "\\u003c";
    }
    if (character === ">") {
      return "\\u003e";
    }
    return "\\u0026";
  });
}

/**
 * 把问题解析结果编译为只供 Agent 消费的版本化协议。
 *
 * @param resolution 服务端确认后的问题解析结果
 * @param questions 创建提问时持久化的问题快照
 */
export function compileQuestionResponseProtocol(
  resolution: QuestionResolution,
  questions: PendingQuestionProjection["questions"],
): string {
  if (!Check(QuestionResolutionSchema, resolution)) {
    throw new Error("问题解析结果格式不符合约束");
  }
  const envelope: QuestionResponseEnvelopeV2 = {
    resolution,
    resolvedAnswers: resolveAnswers(resolution, questions),
  };
  const json = escapeProtocolJson(JSON.stringify(envelope));
  return `<bug_paw_question_response version="2">\n${json}\n</bug_paw_question_response>`;
}

/**
 * 从用户消息中提取内部问题协议，其余正文继续作为普通消息展示。
 *
 * @param text 待解析的用户消息文本
 */
export function parseQuestionResponseProtocol(text: string): ParsedQuestionResponseProtocol {
  const matched = PROTOCOL_PATTERN.exec(text);
  if (!matched) {
    return { visibleText: text };
  }

  try {
    const payload: unknown = JSON.parse(matched[2]);
    const resolution = matched[1] === "1"
      ? Check(QuestionResolutionSchema, payload) ? payload : undefined
      : Check(QuestionResponseEnvelopeV2Schema, payload) ? payload.resolution : undefined;
    if (!resolution) {
      return { visibleText: text };
    }
    return {
      resolution,
      visibleText: matched[3] ?? "",
    };
  } catch {
    return { visibleText: text };
  }
}

/** 使用权威问题快照把不透明 ID 解析为 Agent 可直接理解的答案。 */
function resolveAnswers(
  resolution: QuestionResolution,
  questions: PendingQuestionProjection["questions"],
): QuestionResponseEnvelopeV2["resolvedAnswers"] {
  const questionsById = new Map(questions.map((question) => [question.id, question]));
  return resolution.answers.map((answer) => {
    const question = questionsById.get(answer.questionId);
    if (!question) throw new Error("答案包含未知题目");
    if (answer.kind === "text") {
      return {
        questionId: answer.questionId,
        question: question.question,
        kind: "text" as const,
        text: answer.text,
      };
    }
    const optionsById = new Map(question.options.map((option) => [option.id, option]));
    const options = answer.optionIds.map((optionId) => {
      const option = optionsById.get(optionId);
      if (!option) throw new Error("答案包含未知选项");
      return { optionId, label: option.label, description: option.description };
    });
    return {
      questionId: answer.questionId,
      question: question.question,
      kind: "options" as const,
      options,
    };
  });
}
