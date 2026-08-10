import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConflictDialog } from "./conflict-dialog";

describe("ConflictDialog", () => {
  it("展示本地与磁盘差异，只允许重新加载或在新 revision 上重新应用", () => {
    const onReload = vi.fn();
    const onReapply = vi.fn();
    render(<ConflictDialog differences={[{ field: "retry.maxRetries", local: 5, disk: 3 }]} onReload={onReload} onReapply={onReapply} />);
    expect(screen.getByText("retry.maxRetries")).toBeInTheDocument();
    expect(screen.getByText("5")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /覆盖/u })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改并重新加载" }));
    fireEvent.click(screen.getByRole("button", { name: "在新版本上重新应用" }));
    expect(onReload).toHaveBeenCalledOnce();
    expect(onReapply).toHaveBeenCalledOnce();
  });
});
