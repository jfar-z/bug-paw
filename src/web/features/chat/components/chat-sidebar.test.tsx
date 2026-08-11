import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ChatSidebar } from "./chat-sidebar";

describe("ChatSidebar 会话多选", () => {
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
    onScroll: vi.fn(),
    onPointerDown: vi.fn(),
    onPointerEnd: vi.fn(),
    onOpen: vi.fn(),
    shouldSuppressOpen: vi.fn(() => false),
    onRename: vi.fn(),
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
