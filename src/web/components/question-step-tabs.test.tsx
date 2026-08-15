import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QuestionStepTabs } from "./question-step-tabs";

describe("QuestionStepTabs", () => {
  it("多题支持点击和方向键循环切换并转移焦点", () => {
    const onChange = vi.fn();
    render(<QuestionStepTabs count={3} activeIndex={0} onChange={onChange} label="回答题目" />);

    const tabs = screen.getAllByRole("tab");
    expect(screen.getByRole("tablist", { name: "回答题目" })).toBeVisible();
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.click(tabs[1]);
    expect(onChange).toHaveBeenCalledWith(1);

    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(onChange).toHaveBeenCalledWith(2);
    expect(tabs[2]).toHaveFocus();

    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith(0);
    expect(tabs[0]).toHaveFocus();
  });

  it("单题不渲染切换栏", () => {
    render(<QuestionStepTabs count={1} activeIndex={0} onChange={vi.fn()} label="回答题目" />);

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });
});
