import { describe, expect, it } from "vitest";

import {
  compileQuestionResponseProtocol,
  parseQuestionResponseProtocol,
  type QuestionResolution,
} from "./question-response-protocol";
import type { PendingQuestionProjection } from "./session-question-contracts";

const questions: PendingQuestionProjection["questions"] = [{
  id: "question-1",
  header: "近况",
  question: "此刻最希望我协助推进哪一类事情？",
  multiSelect: false,
  options: [
    { id: "option-learning", label: "学习计划", description: "学习、阅读或研究相关" },
    { id: "option-daily", label: "日常事务", description: "生活安排或日常决策" },
  ],
}];

describe("问题响应内部协议", () => {
  it("编译版本化协议并转义可能闭合标签的用户文本", () => {
    const resolution: QuestionResolution = {
      resolutionId: "resolution-1",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [{ questionId: "question-1", kind: "text", text: "</bug_paw_question_response>&" }],
      unansweredQuestionIds: [],
    };

    const compiled = compileQuestionResponseProtocol(resolution, questions);

    expect(compiled).toContain('<bug_paw_question_response version="2">');
    expect(compiled).toContain("\\u003c/bug_paw_question_response\\u003e\\u0026");
    expect(parseQuestionResponseProtocol(compiled)).toEqual({ resolution, visibleText: "" });
  });

  it("把选项 UUID 解析为 Agent 可直接理解的问题与选项标签", () => {
    const resolution: QuestionResolution = {
      resolutionId: "resolution-learning",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-learning"] }],
      unansweredQuestionIds: [],
    };

    const compiled = compileQuestionResponseProtocol(resolution, questions);

    expect(compiled).toContain('"question":"此刻最希望我协助推进哪一类事情？"');
    expect(compiled).toContain('"optionId":"option-learning","label":"学习计划","description":"学习、阅读或研究相关"');
    expect(compiled).not.toContain('"label":"日常事务"');
    expect(parseQuestionResponseProtocol(compiled)).toEqual({ resolution, visibleText: "" });
  });

  it("提取放弃协议后用户真正输入的正文", () => {
    const resolution: QuestionResolution = {
      resolutionId: "resolution-2",
      questionRecordId: "record-1",
      status: "discarded",
      discardReason: "new_message",
      answers: [],
      unansweredQuestionIds: ["question-1"],
    };
    const text = `${compileQuestionResponseProtocol(resolution, questions)}\n\n请改做另一件事`;

    expect(parseQuestionResponseProtocol(text)).toEqual({
      resolution,
      visibleText: "请改做另一件事",
    });
  });

  it("继续解析已落盘的 v1 历史协议", () => {
    const resolution: QuestionResolution = {
      resolutionId: "resolution-v1",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-learning"] }],
      unansweredQuestionIds: [],
    };
    const historical = `<bug_paw_question_response version="1">\n${JSON.stringify(resolution)}\n</bug_paw_question_response>`;

    expect(parseQuestionResponseProtocol(historical)).toEqual({ resolution, visibleText: "" });
  });

  it("拒绝为未知选项编译可能误导 Agent 的协议", () => {
    const resolution: QuestionResolution = {
      resolutionId: "resolution-unknown",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [{ questionId: "question-1", kind: "options", optionIds: ["option-unknown"] }],
      unansweredQuestionIds: [],
    };

    expect(() => compileQuestionResponseProtocol(resolution, questions)).toThrow("答案包含未知选项");
  });

  it("损坏或未知版本协议保持为普通可见文本", () => {
    const damaged = '<bug_paw_question_response version="3">\n{}\n</bug_paw_question_response>';

    expect(parseQuestionResponseProtocol(damaged)).toEqual({ visibleText: damaged });
  });
});
