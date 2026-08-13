import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

import { SubmittedQuestionAnswerSchema } from "./session-question-contracts";

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

export interface ParsedQuestionResponseProtocol {
  resolution?: QuestionResolution;
  visibleText: string;
}

const PROTOCOL_PATTERN = /^<bug_paw_question_response version="1">\n([\s\S]*?)\n<\/bug_paw_question_response>(?:\n\n([\s\S]*))?$/u;

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
 */
export function compileQuestionResponseProtocol(resolution: QuestionResolution): string {
  if (!Check(QuestionResolutionSchema, resolution)) {
    throw new Error("问题解析结果格式不符合约束");
  }
  const json = escapeProtocolJson(JSON.stringify(resolution));
  return `<bug_paw_question_response version="1">\n${json}\n</bug_paw_question_response>`;
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
    const resolution: unknown = JSON.parse(matched[1]);
    if (!Check(QuestionResolutionSchema, resolution)) {
      return { visibleText: text };
    }
    return {
      resolution,
      visibleText: matched[2] ?? "",
    };
  } catch {
    return { visibleText: text };
  }
}
