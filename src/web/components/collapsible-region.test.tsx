import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CollapsibleRegion } from "./collapsible-region";

describe("CollapsibleRegion", () => {
  it("收起时保留内容并从可访问树隐藏", () => {
    const { container } = render(
      <CollapsibleRegion expanded={false} className="tool-details">
        <span>保留的详情</span>
      </CollapsibleRegion>,
    );

    expect(screen.getByText("保留的详情")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("collapsible-region", "tool-details");
    expect(container.firstElementChild).not.toHaveClass("is-expanded");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("展开时暴露内容并提供统一内层", () => {
    const { container } = render(
      <CollapsibleRegion expanded className="thinking-details">
        <span>展开的详情</span>
      </CollapsibleRegion>,
    );

    expect(container.firstElementChild).toHaveClass("is-expanded");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "false");
    expect(container.querySelector(".collapsible-region__inner")).toHaveTextContent("展开的详情");
  });
});
