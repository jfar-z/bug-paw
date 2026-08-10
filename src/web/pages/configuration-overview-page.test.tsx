import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationOverviewPage } from "./configuration-overview-page";

describe("ConfigurationOverviewPage", () => {
  it("只展示真实配置入口，且不再呈现过期占位状态", () => {
    const onNavigate = vi.fn();
    render(<ConfigurationOverviewPage onNavigate={onNavigate} />);

    expect(screen.getByRole("heading", { name: "配置中心" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /运行设置/ })).toBeInTheDocument();
    expect(screen.getByText("把模型、规则和工作环境安顿好，让 BUG 专注继续工作。"))
      .toBeInTheDocument();
    expect(screen.queryByText(/V0/u)).not.toBeInTheDocument();
    expect(screen.queryByText("等待配置接口")).not.toBeInTheDocument();
    expect(screen.queryByText("默认 Agent")).not.toBeInTheDocument();
    expect(screen.getByAltText("BUG 猫咪像素吉祥物")).toHaveAttribute(
      "src",
      "/brand/bugpaw/bugpaw-mascot.png",
    );

    fireEvent.click(screen.getByRole("button", { name: /模型与凭证/u }));
    expect(onNavigate).toHaveBeenCalledWith({ page: "providers" });
  });
});
