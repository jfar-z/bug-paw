import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

/** 创建不允许额外字段的对象 Schema。 */
function strictObject<T extends Record<string, TSchema>>(properties: T) {
  return Type.Object(properties, { additionalProperties: false });
}

/** Agent 调用 ask_user 时提交的选项。 */
export const AskUserOptionSchema = strictObject({
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 500 }),
});

/** Agent 调用 ask_user 时提交的单道题。 */
export const AskUserQuestionSchema = strictObject({
  header: Type.String({ minLength: 1, maxLength: 12 }),
  question: Type.String({ minLength: 1, maxLength: 1_000 }),
  options: Type.Array(AskUserOptionSchema, { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Boolean(),
});

/** ask_user 工具参数。 */
export const AskUserParametersSchema = strictObject({
  questions: Type.Array(AskUserQuestionSchema, { minItems: 1, maxItems: 4 }),
});

export type AskUserParameters = Static<typeof AskUserParametersSchema>;

/** 服务端为选项补充稳定标识后的投影。 */
export const PendingQuestionOptionSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.String({ minLength: 1, maxLength: 500 }),
});

/** 服务端为题目补充稳定标识后的投影。 */
export const PendingQuestionItemSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  header: Type.String({ minLength: 1, maxLength: 12 }),
  question: Type.String({ minLength: 1, maxLength: 1_000 }),
  options: Type.Array(PendingQuestionOptionSchema, { minItems: 2, maxItems: 4 }),
  multiSelect: Type.Boolean(),
});

/** 返回给浏览器的待回答问题，不包含服务端内部解析状态。 */
export const PendingQuestionProjectionSchema = strictObject({
  id: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  toolCallId: Type.String({ minLength: 1 }),
  questions: Type.Array(PendingQuestionItemSchema, { minItems: 1, maxItems: 4 }),
  createdAt: Type.String({ minLength: 1 }),
});

export type PendingQuestionProjection = Static<typeof PendingQuestionProjectionSchema>;

/** 用户以选项方式回答一道题。 */
export const OptionQuestionAnswerSchema = strictObject({
  questionId: Type.String({ minLength: 1 }),
  kind: Type.Literal("options"),
  optionIds: Type.Array(Type.String({ minLength: 1 }), {
    minItems: 1,
    maxItems: 4,
    uniqueItems: true,
  }),
});

/** 用户以自由文本方式回答一道题。 */
export const TextQuestionAnswerSchema = strictObject({
  questionId: Type.String({ minLength: 1 }),
  kind: Type.Literal("text"),
  text: Type.String({ minLength: 1, maxLength: 10_000 }),
});

/** 单道题的结构化答案。 */
export const SubmittedQuestionAnswerSchema = Type.Union([
  OptionQuestionAnswerSchema,
  TextQuestionAnswerSchema,
]);

export type SubmittedQuestionAnswer = Static<typeof SubmittedQuestionAnswerSchema>;

/** 提交问题答案的请求体；允许零答案和提前提交。 */
export const SubmitQuestionAnswersSchema = strictObject({
  version: Type.Integer({ minimum: 1 }),
  answers: Type.Array(SubmittedQuestionAnswerSchema, { maxItems: 4 }),
});

export type SubmitQuestionAnswers = Static<typeof SubmitQuestionAnswersSchema>;

/** 完成语义校验后的答案。 */
export interface ValidatedQuestionAnswers {
  answers: SubmittedQuestionAnswer[];
  unansweredQuestionIds: string[];
}

/** 答案与当前问题不匹配。 */
export class QuestionAnswerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionAnswerValidationError";
  }
}

/**
 * 校验提交答案与待回答问题之间的语义关系。
 *
 * @param pending 当前待回答问题
 * @param input 浏览器提交的答案
 */
export function validateSubmittedAnswers(
  pending: PendingQuestionProjection,
  input: SubmitQuestionAnswers,
): ValidatedQuestionAnswers {
  if (!Check(SubmitQuestionAnswersSchema, input)) {
    throw new QuestionAnswerValidationError("答案格式不符合约束");
  }
  if (input.version !== pending.version) {
    throw new QuestionAnswerValidationError("提问版本已变化");
  }

  const questions = new Map(pending.questions.map((question) => [question.id, question]));
  const answered = new Set<string>();
  let textLength = 0;

  for (const answer of input.answers) {
    if (answered.has(answer.questionId)) {
      throw new QuestionAnswerValidationError("同一道题不能重复回答");
    }

    const question = questions.get(answer.questionId);
    if (!question) {
      throw new QuestionAnswerValidationError("答案包含未知题目");
    }
    answered.add(answer.questionId);

    if (answer.kind === "text") {
      if (answer.text.trim().length === 0) {
        throw new QuestionAnswerValidationError("文本答案不能为空");
      }
      textLength += Array.from(answer.text).length;
      continue;
    }

    if (!question.multiSelect && answer.optionIds.length !== 1) {
      throw new QuestionAnswerValidationError("单选题只能提交一个选项");
    }
    const knownOptionIds = new Set(question.options.map((option) => option.id));
    if (answer.optionIds.some((optionId) => !knownOptionIds.has(optionId))) {
      throw new QuestionAnswerValidationError("答案包含未知选项");
    }
  }

  if (textLength > 40_000) {
    throw new QuestionAnswerValidationError("文本答案总长度超过限制");
  }

  return {
    answers: structuredClone(input.answers),
    unansweredQuestionIds: pending.questions
      .filter((question) => !answered.has(question.id))
      .map((question) => question.id),
  };
}
