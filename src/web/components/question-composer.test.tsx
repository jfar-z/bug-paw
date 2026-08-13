import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PendingQuestionProjection } from "../../shared/session-question-contracts";
import type { QuestionDraftController } from "../use-question-draft";
import { QuestionComposer } from "./question-composer";

const pending: PendingQuestionProjection = {
  id: "record-1",
  version: 1,
  toolCallId: "ask-1",
  createdAt: "2026-08-13T08:00:00.000Z",
  questions: [
    {
      id: "q-1",
      header: "范围",
      question: "需要处理哪些内容？",
      multiSelect: false,
      options: [
        { id: "o-1", label: "全部", description: "处理全部内容" },
        { id: "o-2", label: "部分", description: "只处理一部分" },
      ],
    },
    {
      id: "q-2",
      header: "格式",
      question: "需要哪些输出格式？",
      multiSelect: true,
      options: [
        { id: "o-3", label: "Markdown", description: "生成 Markdown" },
        { id: "o-4", label: "HTML", description: "生成 HTML" },
      ],
    },
  ],
};

function controller(overrides: Partial<QuestionDraftController> = {}): QuestionDraftController {
  return {
    draft: { questionIndex: 0, answers: {}, collapsed: false, updatedAt: new Date().toISOString() },
    answeredCount: 0,
    setQuestionIndex: vi.fn(),
    toggleOption: vi.fn(),
    setText: vi.fn(),
    setCollapsed: vi.fn(),
    buildSubmission: vi.fn(() => []),
    clear: vi.fn(),
    ...overrides,
  };
}

describe("QuestionComposer", () => {
  it("逐题展示原生选项、说明、自由输入和进度", () => {
    const draft = controller();
    render(<QuestionComposer pending={pending} draft={draft} submitting={false} onCollapse={vi.fn()} onSubmit={vi.fn()} />);

    expect(screen.getByText("问题 1/2")).toBeVisible();
    expect(screen.getByText("已回答 0/2")).toBeVisible();
    expect(screen.getByRole("radio", { name: /全部.*处理全部内容/ })).toBeVisible();
    expect(screen.getByLabelText("其他回答（可选）")).toBeVisible();
    expect(screen.getByRole("button", { name: "暂不回答并提交" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "下一题" }));
    expect(draft.setQuestionIndex).toHaveBeenCalledWith(1);
  });

  it("把选项和文字操作交给互斥草稿控制器", () => {
    const draft = controller();
    render(<QuestionComposer pending={pending} draft={draft} submitting={false} onCollapse={vi.fn()} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("radio", { name: /部分/ }));
    fireEvent.change(screen.getByLabelText("其他回答（可选）"), { target: { value: "仅修改前端" } });
    expect(draft.toggleOption).toHaveBeenCalledWith("q-1", "o-2");
    expect(draft.setText).toHaveBeenCalledWith("q-1", "仅修改前端");
  });

  it("允许提前提交并显示已回答数量", () => {
    const answers = [{ questionId: "q-1", kind: "options" as const, optionIds: ["o-1"] }];
    const draft = controller({
      answeredCount: 1,
      buildSubmission: vi.fn(() => answers),
      draft: {
        questionIndex: 1,
        collapsed: false,
        updatedAt: new Date().toISOString(),
        answers: { "q-1": { optionIds: ["o-1"], text: "" } },
      },
    });
    const onSubmit = vi.fn();
    render(<QuestionComposer pending={pending} draft={draft} submitting={false} onCollapse={vi.fn()} onSubmit={onSubmit} />);

    expect(screen.getByRole("checkbox", { name: /Markdown/ })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "提交已回答的 1/2 题" }));
    expect(onSubmit).toHaveBeenCalledWith(answers);
  });

  it("支持收起和提交中防重复操作", () => {
    const onCollapse = vi.fn();
    render(<QuestionComposer pending={pending} draft={controller()} submitting onCollapse={onCollapse} onSubmit={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "收起提问处理框" }));
    expect(onCollapse).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "正在提交回答" })).toBeDisabled();
  });
});
