import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationOverviewPage } from "./configuration-overview-page";

describe("ConfigurationOverviewPage", () => {
  it("展示可用配置入口并将选择交给路由", () => {
    const onNavigate = vi.fn();
    render(<ConfigurationOverviewPage onNavigate={onNavigate} />);

    expect(screen.getByRole("heading", { name: "配置中心" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /运行设置/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /模型与凭证/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /模型与凭证/u }));
    expect(onNavigate).toHaveBeenCalledWith({ page: "providers" });
  });
});
