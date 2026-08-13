import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";

import {
  AskUserParametersSchema,
  SubmitQuestionAnswersSchema,
  validateSubmittedAnswers,
  type PendingQuestionProjection,
} from "./session-question-contracts";

const pending: PendingQuestionProjection = {
  id: "question-record-1",
  version: 1,
  toolCallId: "call-1",
  createdAt: "2026-08-13T00:00:00.000Z",
  questions: [
    {
      id: "question-1",
      header: "方案",
      question: "选择实现方案",
      multiSelect: false,
      options: [
        { id: "option-1", label: "方案 A", description: "保持现状" },
        { id: "option-2", label: "方案 B", description: "采用新流程" },
      ],
    },
    {
      id: "question-2",
      header: "能力",
      question: "选择需要的能力",
      multiSelect: true,
      options: [
        { id: "option-3", label: "搜索", description: "启用搜索" },
        { id: "option-4", label: "浏览器", description: "启用浏览器" },
      ],
    },
  ],
};

describe("Session Question 共享契约", () => {
  it("只接受 1 至 4 道题且每题包含 2 至 4 个严格选项", () => {
    const validQuestion = {
      header: "方案",
      question: "选择实现方案",
      multiSelect: false,
      options: [
        { label: "A", description: "方案 A" },
        { label: "B", description: "方案 B" },
      ],
    };

    expect(Check(AskUserParametersSchema, { questions: [validQuestion] })).toBe(true);
    expect(Check(AskUserParametersSchema, { questions: [] })).toBe(false);
    expect(Check(AskUserParametersSchema, { questions: Array.from({ length: 5 }, () => validQuestion) })).toBe(false);
    expect(Check(AskUserParametersSchema, {
      questions: [{ ...validQuestion, options: [{ label: "A", description: "只有一个" }] }],
    })).toBe(false);
    expect(Check(AskUserParametersSchema, {
      questions: [{ ...validQuestion, extra: true }],
    })).toBe(false);
  });

  it("接受零答案和部分答案并明确列出未回答题目", () => {
    expect(Check(SubmitQuestionAnswersSchema, { version: 1, answers: [] })).toBe(true);

    expect(validateSubmittedAnswers(pending, {
      version: 1,
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-2"] }],
    })).toEqual({
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-2"] }],
      unansweredQuestionIds: ["question-2"],
    });
  });

  it("拒绝单选多值、未知选项和同一题重复回答", () => {
    expect(() => validateSubmittedAnswers(pending, {
      version: 1,
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-1", "option-2"] }],
    })).toThrow("单选题只能提交一个选项");

    expect(() => validateSubmittedAnswers(pending, {
      version: 1,
      answers: [{ questionId: "question-2", kind: "options", optionIds: ["unknown"] }],
    })).toThrow("答案包含未知选项");

    expect(() => validateSubmittedAnswers(pending, {
      version: 1,
      answers: [
        { questionId: "question-2", kind: "text", text: "自定义" },
        { questionId: "question-2", kind: "options", optionIds: ["option-3"] },
      ],
    })).toThrow("同一道题不能重复回答");
  });
});
