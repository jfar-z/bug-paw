import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { QuickWorkspaceDrawer } from "./quick-workspace-drawer";

describe("QuickWorkspaceDrawer", () => {
  it("固定当前 Agent 并提供关闭入口", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ entries: [] }))));
    const onClose = vi.fn();
    render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><QuickWorkspaceDrawer open agentId="agent-a" agentName="默认 Agent" onClose={onClose} /></ApiTaskProvider></ErrorToastProvider>);

    expect(screen.getByRole("complementary", { name: "快捷资源管理" })).toHaveClass("is-open");
    expect(screen.queryByText("切换 Agent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭快捷资源管理" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
