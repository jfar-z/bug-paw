import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProductMark } from "./product-mark";

describe("ProductMark", () => {
  it("使用正式猫头资产呈现完整 BugPaw 标识", () => {
    render(<ProductMark />);

    const mark = screen.getByLabelText("BugPaw");
    expect(mark).toHaveTextContent("BugPaw");
    expect(mark.querySelector("img")).toHaveAttribute(
      "src",
      "/brand/bugpaw/bugpaw-app-icon-brown-paw.png",
    );
  });

  it("紧凑模式保留可访问名称但隐藏文字字标", () => {
    render(<ProductMark compact />);

    const mark = screen.getByLabelText("BugPaw");
    expect(mark).toHaveClass("is-compact");
    expect(mark.querySelector("img")).toBeInTheDocument();
    expect(mark.querySelector(".product-mark__name")).not.toBeInTheDocument();
  });
});
