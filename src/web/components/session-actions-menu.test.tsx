import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionActionsMenu } from "./session-actions-menu";

const session = {
  id: "session-1",
  name: "研究记录",
  firstMessage: "第一条消息",
  modified: "2026-08-05T08:00:00.000Z",
  messageCount: 3,
};

describe("SessionActionsMenu", () => {
  it("支持重命名和归档会话", () => {
    const onRename = vi.fn();
    const onArchive = vi.fn();
    render(<SessionActionsMenu session={session} onRename={onRename} onArchive={onArchive} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const input = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(input, { target: { value: "新的名称" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("新的名称");

    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
    expect(onArchive).toHaveBeenCalledOnce();
  });

  it("永久删除前要求二次确认，并可禁用危险操作", () => {
    const onDelete = vi.fn();
    const { rerender } = render(
      <SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onDelete).toHaveBeenCalledWith(false);

    rerender(<SessionActionsMenu session={session} disabled onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    expect(screen.getByRole("menuitem", { name: "归档" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "删除" })).toBeDisabled();
  });

  it("删除绑定定时任务的会话时明确要求停用并保留任务", () => {
    const onDelete = vi.fn();
    render(<SessionActionsMenu session={{ ...session, scheduledTaskCount: 2 }} onRename={vi.fn()} onArchive={vi.fn()} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    const warning = screen.getByText(/绑定的 2 个定时任务将同步停用/);
    expect(warning).toHaveClass("session-actions__task-warning");
    expect(warning).toHaveTextContent("任务记录会保留");
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(onDelete).toHaveBeenCalledWith(true);
  });

  it("接收到新的展开请求时打开菜单", () => {
    const { rerender } = render(
      <SessionActionsMenu session={session} openRequestId={0} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />,
    );

    rerender(<SessionActionsMenu session={session} openRequestId={1} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("可从三点菜单进入多选模式", () => {
    const onSelectMultiple = vi.fn();
    render(<SessionActionsMenu session={session} onRename={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} onSelectMultiple={onSelectMultiple} />);

    fireEvent.click(screen.getByRole("button", { name: "管理会话：研究记录" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));

    expect(onSelectMultiple).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
