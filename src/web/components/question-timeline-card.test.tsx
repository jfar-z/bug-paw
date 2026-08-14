import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ToolBlock } from "../conversation-timeline";
import { QuestionTimelineCard } from "./question-timeline-card";

const pendingQuestion = {
  id: "question-1",
  version: 1,
  toolCallId: "ask-1",
  createdAt: "2026-08-13T08:00:00.000Z",
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

function block(details: unknown, status: ToolBlock["status"] = "completed"): ToolBlock {
  return { id: "ask", type: "tool", callId: "ask-1", name: "ask_user", args: { secret: "不得展示" }, details, status };
}

describe("QuestionTimelineCard", () => {
  it("提问仍在创建时展示中性等待状态而不是失败", () => {
    render(<QuestionTimelineCard tool={block(undefined, "running")} />);

    expect(screen.getByText("正在创建提问")).toBeVisible();
    expect(screen.queryByText("提问未能创建")).not.toBeInTheDocument();
  });

  it("展示待回答问题摘要且不泄露原始参数", () => {
    render(<QuestionTimelineCard tool={block({ type: "question_pending", pendingQuestion })} />);

    expect(screen.getByText("等待回答")).toBeVisible();
    expect(screen.getByText("共 2 个问题")).toBeVisible();
    expect(screen.queryByText("不得展示")).not.toBeInTheDocument();
  });

  it("回答后只显示 Agent 提问终态而不展开答案", () => {
    render(<QuestionTimelineCard tool={block({
      type: "question_pending",
      pendingQuestion,
      resolution: {
        resolutionId: "r-1",
        questionRecordId: "question-1",
        status: "submitted",
        answers: [
          { questionId: "q-1", kind: "options", optionIds: ["o-2"] },
          { questionId: "q-2", kind: "text", text: "保留现状" },
        ],
        unansweredQuestionIds: [],
      },
    })} />);

    expect(screen.getByText("已回答")).toBeVisible();
    expect(screen.getByText("共 2 个问题")).toBeVisible();
    expect(screen.queryByText("部分")).not.toBeInTheDocument();
    expect(screen.queryByText("保留现状")).not.toBeInTheDocument();
    expect(screen.queryByText("未回答 0 题")).not.toBeInTheDocument();
  });

  it("放弃回答后只显示 Agent 提问终态", () => {
    render(<QuestionTimelineCard tool={block({
      type: "question_pending",
      pendingQuestion,
      resolution: {
        resolutionId: "r-2",
        questionRecordId: "question-1",
        status: "discarded",
        discardReason: "new_message",
        answers: [],
        unansweredQuestionIds: ["q-1", "q-2"],
      },
    })} />);

    expect(screen.getByText("已放弃")).toBeVisible();
    expect(screen.queryByText("未回答 2 题")).not.toBeInTheDocument();
  });

  it("对损坏详情显示稳定错误状态而不转储对象", () => {
    render(<QuestionTimelineCard tool={block({ raw: "不得转储" }, "error")} />);

    expect(screen.getByText("提问未能创建")).toBeVisible();
    expect(screen.queryByText("不得转储")).not.toBeInTheDocument();
  });
});
