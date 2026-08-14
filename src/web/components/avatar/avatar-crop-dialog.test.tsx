import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AvatarCropArea } from "../../../shared/avatar-contracts";
import { AvatarCropDialog } from "./avatar-crop-dialog";

vi.mock("react-easy-crop", () => ({
  default: (props: {
    aspect: number;
    cropShape: string;
    showGrid: boolean;
    onCropComplete(area: AvatarCropArea): void;
  }) => (
    <button
      type="button"
      aria-label="设置测试裁剪区域"
      data-aspect={props.aspect}
      data-crop-shape={props.cropShape}
      data-show-grid={String(props.showGrid)}
      onClick={() => props.onCropComplete({ x: 10, y: 0, width: 80, height: 80 })}
    >
      裁剪区域
    </button>
  ),
}));

describe("头像裁剪对话框", () => {
  const createObjectURL = vi.fn(() => "blob:avatar-preview");
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    createObjectURL.mockImplementation(() => "blob:avatar-preview");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("使用固定矩形 1:1 裁剪并回传百分比区域", async () => {
    const onConfirm = vi.fn();
    render(
      <AvatarCropDialog
        file={avatarFile()}
        busy={false}
        onCancel={vi.fn()}
        onReplace={vi.fn()}
        onConfirm={onConfirm}
      />,
    );

    const cropper = screen.getByRole("button", { name: "设置测试裁剪区域" });
    expect(cropper).toHaveAttribute("data-aspect", "1");
    expect(cropper).toHaveAttribute("data-crop-shape", "rect");
    expect(cropper).toHaveAttribute("data-show-grid", "true");
    fireEvent.click(cropper);
    fireEvent.click(screen.getByRole("button", { name: "裁剪并上传" }));

    expect(onConfirm).toHaveBeenCalledWith({ x: 10, y: 0, width: 80, height: 80 });
    expect(screen.getByAltText("圆角方形头像预览")).toHaveAttribute("src", "blob:avatar-preview");
  });

  it("支持 Escape、焦点循环并在关闭后把焦点还给入口", async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>打开裁剪器</button>
          {open ? (
            <AvatarCropDialog
              file={avatarFile()}
              busy={false}
              onCancel={() => setOpen(false)}
              onReplace={vi.fn()}
              onConfirm={vi.fn()}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "打开裁剪器" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "调整头像" });
    const close = screen.getByRole("button", { name: "关闭头像裁剪" });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "设置测试裁剪区域" }));
    const confirm = screen.getByRole("button", { name: "裁剪并上传" });
    confirm.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    close.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "调整头像" })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it("失败时保留编辑状态并支持重新选择，提交期间禁用确认", () => {
    const onReplace = vi.fn();
    const view = render(
      <AvatarCropDialog
        file={avatarFile()}
        busy={false}
        error="图片处理失败"
        onCancel={vi.fn()}
        onReplace={onReplace}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("图片处理失败");
    expect(screen.getByRole("button", { name: "重新选择" })).toBeEnabled();
    const replacement = new File(["new"], "new.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("重新选择头像"), { target: { files: [replacement] } });
    expect(onReplace).toHaveBeenCalledWith(replacement);
    view.rerender(
      <AvatarCropDialog
        file={avatarFile()}
        busy
        error="图片处理失败"
        onCancel={vi.fn()}
        onReplace={onReplace}
        onConfirm={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "上传中…" })).toBeDisabled();
  });

  it("窄屏使用全屏结构并释放对象 URL", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const { unmount } = render(
      <AvatarCropDialog
        file={avatarFile()}
        busy={false}
        onCancel={vi.fn()}
        onReplace={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "调整头像" })).toHaveClass("avatar-crop-dialog--mobile");
    expect(screen.getByRole("button", { name: "关闭头像裁剪" })).toHaveStyle({ width: "44px", height: "44px" });
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");
  });

  it("严格模式和文件替换时逐一释放创建的对象 URL", () => {
    let sequence = 0;
    createObjectURL.mockImplementation(() => `blob:avatar-${sequence += 1}`);
    const first = avatarFile();
    const second = new File(["replacement"], "replacement.png", { type: "image/png" });
    const view = render(
      <StrictMode>
        <AvatarCropDialog
          file={first}
          busy={false}
          onCancel={vi.fn()}
          onReplace={vi.fn()}
          onConfirm={vi.fn()}
        />
      </StrictMode>,
    );

    view.rerender(
      <StrictMode>
        <AvatarCropDialog
          file={second}
          busy={false}
          onCancel={vi.fn()}
          onReplace={vi.fn()}
          onConfirm={vi.fn()}
        />
      </StrictMode>,
    );
    view.unmount();

    const createdUrls = createObjectURL.mock.results.map((result) => result.value as string);
    expect(createdUrls.length).toBeGreaterThanOrEqual(2);
    for (const url of createdUrls) {
      expect(revokeObjectURL.mock.calls.filter(([revoked]) => revoked === url)).toHaveLength(1);
    }
  });

  it("视口跨过移动端断点时实时切换全屏结构", () => {
    let matches = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      get matches() {
        return matches;
      },
      media: "(max-width: 760px)",
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    })));
    render(
      <AvatarCropDialog
        file={avatarFile()}
        busy={false}
        onCancel={vi.fn()}
        onReplace={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "调整头像" });
    expect(dialog).not.toHaveClass("avatar-crop-dialog--mobile");

    matches = true;
    act(() => listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent)));

    expect(dialog).toHaveClass("avatar-crop-dialog--mobile");
    expect(dialog).toHaveStyle({ width: "100%", minHeight: "100dvh" });
  });
});

function avatarFile(): File {
  return new File(["avatar"], "avatar.png", { type: "image/png" });
}
