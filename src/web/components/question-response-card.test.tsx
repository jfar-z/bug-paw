import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QuestionResponseCard } from "./question-response-card";

const pendingQuestion = {
  id: "question-1",
  version: 1,
  toolCallId: "ask-1",
  createdAt: "2026-08-14T08:00:00.000Z",
  questions: [{
    id: "q-1",
    header: "范围",
    question: "处理范围？",
    multiSelect: false,
    options: [
      { id: "o-1", label: "全部", description: "处理全部" },
      { id: "o-2", label: "部分", description: "处理部分" },
    ],
  }, {
    id: "q-2",
    header: "备注",
    question: "还有补充吗？",
    multiSelect: false,
    options: [
      { id: "o-3", label: "没有", description: "没有补充" },
      { id: "o-4", label: "有", description: "补充说明" },
    ],
  }],
};

describe("QuestionResponseCard", () => {
  it("逐题展示问题原文和Agent实际收到的回答", () => {
    render(<QuestionResponseCard pendingQuestion={pendingQuestion} resolution={{
      resolutionId: "resolution-1",
      questionRecordId: "question-1",
      status: "submitted",
      answers: [
        { questionId: "q-1", kind: "options", optionIds: ["o-2"] },
        { questionId: "q-2", kind: "text", text: "保留现状" },
      ],
      unansweredQuestionIds: [],
    }} />);

    expect(screen.getByRole("region", { name: "用户回答" })).toBeVisible();
    expect(screen.getByText("已提交回答")).toBeVisible();
    expect(screen.getByText("处理范围？")).toBeVisible();
    expect(screen.getByText("部分")).toBeVisible();
    expect(screen.getByText("处理部分")).toBeVisible();
    expect(screen.queryByText("全部")).not.toBeInTheDocument();
    expect(screen.queryByText("处理全部")).not.toBeInTheDocument();
    expect(screen.getByText("未回答 0 题")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "2" }));
    expect(screen.getByText("还有补充吗？")).toBeVisible();
    expect(screen.getByText("保留现状")).toBeVisible();
    expect(screen.queryByText("部分")).not.toBeInTheDocument();
  });

  it("展示放弃状态且不回显未知内部标识", () => {
    render(<QuestionResponseCard pendingQuestion={pendingQuestion} resolution={{
      resolutionId: "resolution-2",
      questionRecordId: "question-1",
      status: "discarded",
      discardReason: "new_message",
      answers: [{ questionId: "unknown-question", kind: "options", optionIds: ["unknown-option"] }],
      unansweredQuestionIds: ["q-1", "q-2"],
    }} />);

    expect(screen.getByText("已放弃回答")).toBeVisible();
    expect(screen.getByText("未提交回答")).toBeVisible();
    expect(screen.getByText("未回答 2 题")).toBeVisible();
    expect(screen.queryByText("unknown-question")).not.toBeInTheDocument();
    expect(screen.queryByText("unknown-option")).not.toBeInTheDocument();
  });

  it("部分回答时逐题明确展示未回答", () => {
    render(<QuestionResponseCard pendingQuestion={pendingQuestion} resolution={{
      resolutionId: "resolution-partial",
      questionRecordId: "question-1",
      status: "submitted",
      answers: [{ questionId: "q-1", kind: "options", optionIds: ["o-2"] }],
      unansweredQuestionIds: ["q-2"],
    }} />);

    fireEvent.click(screen.getByRole("tab", { name: "2" }));
    expect(screen.getByText("还有补充吗？")).toBeVisible();
    expect(screen.getByText("未回答")).toBeVisible();
  });

  it("未知选项不泄露内部标识并显示数据不可用", () => {
    render(<QuestionResponseCard pendingQuestion={pendingQuestion} resolution={{
      resolutionId: "resolution-invalid",
      questionRecordId: "question-1",
      status: "submitted",
      answers: [{ questionId: "q-1", kind: "options", optionIds: ["unknown-option"] }],
      unansweredQuestionIds: ["q-2"],
    }} />);

    expect(screen.getByText("回答数据不可用")).toBeVisible();
    expect(screen.queryByText("unknown-option")).not.toBeInTheDocument();
  });
});
