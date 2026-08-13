import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "./chat-sidebar";

let applicationStyle: HTMLStyleElement;

/** 注入真实应用样式，确保回归测试覆盖 CSS 级联优先级。 */
beforeAll(() => {
  applicationStyle = document.createElement("style");
  applicationStyle.textContent = readFileSync("src/web/styles.css", "utf8");
  document.head.append(applicationStyle);
});

afterAll(() => applicationStyle.remove());

describe("ChatSidebar 会话多选", () => {
  it("搜索按钮位于刷新左侧并按上下文禁用", () => {
    const onSearch = vi.fn();
    const { rerender } = render(<ChatSidebar {...baseProps()} onSearch={onSearch} />);

    const actions = screen.getByRole("group", { name: "会话列表操作" });
    const buttons = within(actions).getAllByRole("button");
    expect(getComputedStyle(actions).display).toBe("flex");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(["搜索聊天记录", "刷新会话列表"]);
    expect(buttons[0]).toHaveAttribute("title", "搜索聊天记录");
    fireEvent.click(buttons[0]!);
    expect(onSearch).toHaveBeenCalledOnce();

    rerender(<ChatSidebar {...baseProps()} selectionMode onSearch={onSearch} />);
    expect(screen.getByRole("button", { name: "搜索聊天记录" })).toBeDisabled();
    rerender(<ChatSidebar {...baseProps()} noAvailableAgent onSearch={onSearch} />);
    expect(screen.getByRole("button", { name: "搜索聊天记录" })).toBeDisabled();
    rerender(<ChatSidebar {...baseProps()} openingSessionId="session-2" onSearch={onSearch} />);
    expect(screen.getByRole("button", { name: "搜索聊天记录" })).toBeDisabled();
  });

  it("为移动端关闭手势声明纵向触摸操作", () => {
    render(<ChatSidebar {...baseProps()} />);

    expect(screen.getByRole("complementary", { name: "会话历史" })).toHaveStyle({ touchAction: "pan-y" });
    expect(screen.getByRole("navigation", { name: "会话历史" })).toHaveStyle({ touchAction: "pan-y" });
  });

  it("进入多选后显示所有复选框，当前会话不可选择", () => {
    const onToggleSelection = vi.fn();
    render(<ChatSidebar {...baseProps()} selectionMode selectedSessionIds={["session-2"]} onToggleSelection={onToggleSelection} />);

    expect(screen.getByRole("checkbox", { name: "选择 当前会话" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择 其他会话" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 其他会话" }));
    expect(onToggleSelection).toHaveBeenCalledWith("session-2");
    expect(screen.queryByRole("button", { name: "管理会话：其他会话" })).not.toBeInTheDocument();
  });

  it("底部操作栏提供归档、删除和取消", () => {
    const onBulkArchive = vi.fn();
    const onBulkDelete = vi.fn();
    const onCancelSelection = vi.fn();
    render(<ChatSidebar {...baseProps()} selectionMode selectedSessionIds={["session-2"]} onBulkArchive={onBulkArchive} onBulkDelete={onBulkDelete} onCancelSelection={onCancelSelection} />);

    fireEvent.click(screen.getByRole("button", { name: "归档已选会话" }));
    fireEvent.click(screen.getByRole("button", { name: "删除已选会话" }));
    fireEvent.click(screen.getByRole("button", { name: "取消多选" }));

    expect(onBulkArchive).toHaveBeenCalledOnce();
    expect(onBulkDelete).toHaveBeenCalledOnce();
    expect(onCancelSelection).toHaveBeenCalledOnce();
  });
});

describe("ChatSidebar 会话置顶分区", () => {
  it("仅在存在置顶会话时显示独立分区，并保留最近会话分区", () => {
    const { rerender } = render(<ChatSidebar {...baseProps()} sessions={[
      { id: "pinned-1", firstMessage: "置顶会话", modified: "2026-08-13T10:00:00.000Z", messageCount: 1, pinned: true },
      { id: "recent-1", firstMessage: "最近会话", modified: "2026-08-13T09:00:00.000Z", messageCount: 1 },
    ]} />);

    expect(screen.getByRole("group", { name: "置顶会话" })).toHaveTextContent("置顶会话");
    expect(screen.getByRole("group", { name: "最近会话" })).toHaveTextContent("最近会话");
    expect(within(screen.getByRole("group", { name: "置顶会话" })).getByLabelText("已置顶")).toBeInTheDocument();

    rerender(<ChatSidebar {...baseProps()} sessions={baseProps().sessions} />);
    expect(screen.queryByRole("group", { name: "置顶会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "最近会话" })).toBeInTheDocument();
  });

  it("置顶与定时任务状态共存时完整展示，并从三点菜单转发取消置顶", () => {
    const onPinChange = vi.fn(async () => true);
    render(<ChatSidebar {...baseProps()} sessions={[
      {
        id: "session-pinned-task",
        firstMessage: "置顶定时会话",
        modified: "2026-08-13T10:00:00.000Z",
        messageCount: 1,
        pinned: true,
        scheduledTaskCount: 2,
      },
    ]} onPinChange={onPinChange} />);

    expect(screen.getByLabelText("已置顶")).toBeInTheDocument();
    expect(screen.getByLabelText("已绑定 2 个定时任务")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "管理会话：置顶定时会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "取消置顶" }));
    expect(onPinChange).toHaveBeenCalledWith("session-pinned-task", false);
  });

  it("多选模式保留置顶和最近分区且不提供批量置顶操作", () => {
    render(<ChatSidebar {...baseProps()} sessions={[
      { id: "pinned-1", firstMessage: "置顶会话", modified: "2026-08-13T10:00:00.000Z", messageCount: 1, pinned: true },
      { id: "recent-1", firstMessage: "最近会话", modified: "2026-08-13T09:00:00.000Z", messageCount: 1 },
    ]} activeSessionId="recent-1" selectionMode selectedSessionIds={["pinned-1"]} />);

    expect(screen.getByRole("group", { name: "置顶会话" })).toHaveTextContent("置顶会话");
    expect(screen.getByRole("group", { name: "最近会话" })).toHaveTextContent("最近会话");
    expect(screen.getByRole("checkbox", { name: "选择 置顶会话" })).toBeChecked();
    expect(screen.queryByRole("menuitem", { name: /置顶/ })).not.toBeInTheDocument();
    expect(within(screen.getByLabelText("会话多选操作")).queryByRole("button", { name: /置顶/ })).not.toBeInTheDocument();
  });
});

function baseProps() {
  return {
    open: true,
    sessions: [
      { id: "session-1", firstMessage: "当前会话", modified: "", messageCount: 1 },
      { id: "session-2", firstMessage: "其他会话", modified: "", messageCount: 1 },
    ],
    activeSessionId: "session-1",
    scrolling: false,
    noAvailableAgent: false,
    streaming: true,
    refreshing: false,
    profileIdentity: { displayName: "管理员", avatarText: "管" },
    selectionMode: false,
    selectedSessionIds: [] as string[],
    onClose: vi.fn(),
    onEnterDraft: vi.fn(),
    onRefresh: vi.fn(),
    onSearch: vi.fn(),
    onScroll: vi.fn(),
    onPointerDown: vi.fn(),
    onPointerEnd: vi.fn(),
    onOpen: vi.fn(),
    shouldSuppressOpen: vi.fn(() => false),
    onRename: vi.fn(),
    onPinChange: vi.fn(async () => true),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onShowArchived: vi.fn(),
    onEditProfile: vi.fn(),
    onEnterSelection: vi.fn(),
    onToggleSelection: vi.fn(),
    onCancelSelection: vi.fn(),
    onBulkArchive: vi.fn(),
    onBulkDelete: vi.fn(),
  };
}
