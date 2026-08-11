import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArchivedSessionsDialog } from "./archived-sessions-dialog";

const sessions = [{
  id: "archived-1",
  name: "已归档研究",
  firstMessage: "研究问题",
  modified: "2026-08-05T08:00:00.000Z",
  messageCount: 4,
}];

describe("ArchivedSessionsDialog", () => {
  it("展示归档会话并支持打开和恢复", () => {
    const onOpen = vi.fn();
    const onRestore = vi.fn();
    render(
      <ArchivedSessionsDialog open sessions={sessions} busy={false} onClose={vi.fn()} onOpen={onOpen} onRestore={onRestore} onDelete={vi.fn()} onRestoreAll={vi.fn()} onDeleteAll={vi.fn()} />,
    );

    expect(screen.getByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开已归档研究" }));
    expect(onOpen).toHaveBeenCalledWith("archived-1");
    fireEvent.click(screen.getByRole("button", { name: "恢复已归档研究" }));
    expect(onRestore).toHaveBeenCalledWith("archived-1");
  });

  it("永久删除归档会话前要求二次确认", () => {
    const onDelete = vi.fn();
    render(
      <ArchivedSessionsDialog open sessions={sessions} busy={false} onClose={vi.fn()} onOpen={vi.fn()} onRestore={vi.fn()} onDelete={onDelete} onRestoreAll={vi.fn()} onDeleteAll={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "删除已归档研究" }));
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认永久删除" }));
    expect(onDelete).toHaveBeenCalledWith("archived-1");
  });

  it("展示归档数量并抛出全部恢复和全部删除意图", () => {
    const onRestoreAll = vi.fn();
    const onDeleteAll = vi.fn();
    render(
      <ArchivedSessionsDialog open sessions={sessions} busy={false} onClose={vi.fn()} onOpen={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} onRestoreAll={onRestoreAll} onDeleteAll={onDeleteAll} />,
    );

    expect(screen.getByText("共 1 个会话")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部恢复" }));
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    expect(onRestoreAll).toHaveBeenCalledOnce();
    expect(onDeleteAll).toHaveBeenCalledOnce();
  });

  it("空列表或批量处理中禁用全部和单行操作", () => {
    const { rerender } = render(
      <ArchivedSessionsDialog open sessions={[]} busy={false} onClose={vi.fn()} onOpen={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} onRestoreAll={vi.fn()} onDeleteAll={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "全部恢复" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部删除" })).toBeDisabled();

    rerender(
      <ArchivedSessionsDialog open sessions={sessions} busy onClose={vi.fn()} onOpen={vi.fn()} onRestore={vi.fn()} onDelete={vi.fn()} onRestoreAll={vi.fn()} onDeleteAll={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "全部恢复" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "全部删除" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "打开已归档研究" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "恢复已归档研究" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "删除已归档研究" })).toBeDisabled();
  });
});
