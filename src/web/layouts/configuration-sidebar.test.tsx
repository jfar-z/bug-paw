import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationSidebar } from "./configuration-sidebar";

describe("ConfigurationSidebar", () => {
  it("将运行设置作为 BugPaw 的产品入口呈现", () => {
    render(<ConfigurationSidebar route={{ page: "pi-settings" }} open onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(screen.getByRole("button", { name: "运行设置" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("核心配置为事实来源")).toBeInTheDocument();
    expect(screen.queryByText("Pi 运行设置")).not.toBeInTheDocument();
  });

  it("将联网搜索作为能力扩展分组下的二级菜单", () => {
    render(<ConfigurationSidebar route={{ page: "web-research" }} open onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(screen.getByText("能力扩展", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "联网搜索" })).toHaveAttribute("aria-current", "page");
  });
});
