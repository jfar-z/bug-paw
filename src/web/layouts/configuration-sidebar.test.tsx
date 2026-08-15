import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationSidebar } from "./configuration-sidebar";

describe("ConfigurationSidebar", () => {
  it("标记当前配置入口并将导航交给工作台", () => {
    const onNavigate = vi.fn();
    render(<ConfigurationSidebar route={{ page: "pi-settings" }} open onClose={vi.fn()} onNavigate={onNavigate} />);

    expect(screen.getByRole("button", { name: "运行设置" })).toHaveAttribute("aria-current", "page");
    fireEvent.click(screen.getByRole("button", { name: "模型与凭证" }));
    expect(onNavigate).toHaveBeenCalledWith({ page: "providers" });
  });

  it("将联网搜索作为能力扩展分组下的二级菜单", () => {
    render(<ConfigurationSidebar route={{ page: "web-research" }} open onClose={vi.fn()} onNavigate={vi.fn()} />);

    expect(screen.getByText("能力扩展", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "联网搜索" })).toHaveAttribute("aria-current", "page");
  });
});
