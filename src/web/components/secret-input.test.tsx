import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SecretInput } from "./secret-input";

describe("SecretInput", () => {
  it("点击小眼睛切换输入框类型并通知调用方", () => {
    const onVisibilityChange = vi.fn();
    render(<SecretInput aria-label="测试密钥" value="secret" visible={false} onChange={vi.fn()} onVisibilityChange={onVisibilityChange} />);

    expect(screen.getByLabelText("测试密钥")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "显示测试密钥" }));
    expect(onVisibilityChange).toHaveBeenCalledWith(true);
  });
});
