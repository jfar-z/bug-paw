import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { QuickWorkspaceDrawer } from "./quick-workspace-drawer";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";

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

  it("移动端返回依次关闭覆盖预览和资源抽屉", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ entries: [{ path: "demo.png", name: "demo.png", kind: "file", mediaType: "image/png", modifiedAt: "2026-08-12T00:00:00.000Z" }] }))));
    const onClose = vi.fn();
    render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><QuickWorkspaceDrawer open agentId="agent-a" onClose={onClose} /></ApiTaskProvider></ErrorToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "预览 demo.png" }));

    act(() => expect(window.dispatchEvent(new Event(MOBILE_BACK_REQUEST_EVENT, { cancelable: true }))).toBe(false));
    expect(screen.queryByLabelText("demo.png 预览")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    act(() => expect(window.dispatchEvent(new Event(MOBILE_BACK_REQUEST_EVENT, { cancelable: true }))).toBe(false));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
