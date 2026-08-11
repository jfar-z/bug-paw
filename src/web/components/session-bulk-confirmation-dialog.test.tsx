import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SessionBulkPreview } from "../api";
import { SessionBulkConfirmationDialog } from "./session-bulk-confirmation-dialog";

describe("SessionBulkConfirmationDialog", () => {
  it("删除含定时任务的会话时强化提示任务将停用但保留", () => {
    const onConfirm = vi.fn();
    render(<SessionBulkConfirmationDialog preview={preview("delete")} onCancel={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByRole("dialog", { name: "确认删除 2 个会话" })).toBeInTheDocument();
    const warning = screen.getByRole("alert");
    expect(warning).toHaveClass("session-bulk-dialog__task-warning", "is-destructive");
    expect(warning).toHaveTextContent("2 个定时任务");
    expect(warning).toHaveTextContent("同步停用");
    expect(warning).toHaveTextContent("任务记录会保留");
    expect(warning).toHaveTextContent("重新选择目标");
    fireEvent.click(screen.getByRole("button", { name: "删除会话并停用任务" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("归档含定时任务的会话时提示任务仍会继续运行", () => {
    render(<SessionBulkConfirmationDialog preview={preview("archive")} onCancel={vi.fn()} onConfirm={vi.fn()} />);

    const warning = screen.getByRole("alert");
    expect(warning).toHaveTextContent("仍保持启用并继续运行");
    expect(screen.getByRole("button", { name: "归档会话" })).toBeInTheDocument();
  });
});

function preview(action: "archive" | "delete"): SessionBulkPreview {
  return {
    action,
    sessionIds: ["session-1", "session-2"],
    sessionCount: 2,
    tasks: [
      { id: "task-1", name: "日报", sessionId: "session-1" },
      { id: "task-2", name: "周报", sessionId: "session-2" },
    ],
    fingerprint: "fingerprint-1",
  };
}
