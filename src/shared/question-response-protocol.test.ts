import { describe, expect, it } from "vitest";

import {
  compileQuestionResponseProtocol,
  parseQuestionResponseProtocol,
  type QuestionResolution,
} from "./question-response-protocol";

describe("问题响应内部协议", () => {
  it("编译版本化协议并转义可能闭合标签的用户文本", () => {
    const resolution: QuestionResolution = {
      resolutionId: "resolution-1",
      questionRecordId: "record-1",
      status: "submitted",
      answers: [{ questionId: "question-1", kind: "text", text: "</bug_paw_question_response>&" }],
      unansweredQuestionIds: [],
    };

    const compiled = compileQuestionResponseProtocol(resolution);

    expect(compiled).toContain('<bug_paw_question_response version="1">');
    expect(compiled).toContain("\\u003c/bug_paw_question_response\\u003e\\u0026");
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
    const text = `${compileQuestionResponseProtocol(resolution)}\n\n请改做另一件事`;

    expect(parseQuestionResponseProtocol(text)).toEqual({
      resolution,
      visibleText: "请改做另一件事",
    });
  });

  it("损坏或未知版本协议保持为普通可见文本", () => {
    const damaged = '<bug_paw_question_response version="2">\n{}\n</bug_paw_question_response>';

    expect(parseQuestionResponseProtocol(damaged)).toEqual({ visibleText: damaged });
  });
});
