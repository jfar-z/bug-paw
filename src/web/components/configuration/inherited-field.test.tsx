import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InheritedField } from "./inherited-field";

describe("InheritedField", () => {
  it("可以在继承全局值和 Agent 覆盖值之间切换", () => {
    const onInheritedChange = vi.fn();
    render(
      <InheritedField label="默认模型" inherited inheritedValue="openai / gpt-5" onInheritedChange={onInheritedChange}>
        <select aria-label="Agent 默认模型"><option>自定义模型</option></select>
      </InheritedField>,
    );

    expect(screen.getByText("当前继承：openai / gpt-5")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent 默认模型")).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "使用全局默认值" }));
    expect(onInheritedChange).toHaveBeenCalledWith(false);
  });
});
