import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfirmationDialog } from "./confirmation-dialog";

describe("ConfirmationDialog", () => {
  it("展示影响说明，并将确认和取消交给调用方", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();

    render(<ConfirmationDialog title="确认刷新 Pi 配置" description="会中断正在生成的对话。" confirmLabel="继续刷新" onCancel={onCancel} onConfirm={onConfirm} />);

    expect(screen.getByRole("dialog", { name: "确认刷新 Pi 配置" })).toBeInTheDocument();
    expect(screen.getByText("会中断正在生成的对话。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    fireEvent.click(screen.getByRole("button", { name: "继续刷新" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});
