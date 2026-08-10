import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceFileSummary } from "../../shared/contracts";
import { MediaLightbox } from "./media-lightbox";

const firstImage: WorkspaceFileSummary = {
  path: "attachments/first.png",
  name: "第一张图片.png",
  mediaType: "image/png",
  size: 1024,
  modifiedAt: "2026-08-06T00:00:00.000Z",
};

const secondImage: WorkspaceFileSummary = {
  path: "attachments/second.png",
  name: "第二张图片.png",
  mediaType: "image/png",
  size: 2048,
  modifiedAt: "2026-08-06T00:00:00.000Z",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("MediaLightbox", () => {
  it("在图片间通过按钮和水平滑动切换", () => {
    render(<MediaLightbox item={firstImage} images={[firstImage, secondImage]} onClose={vi.fn()} />);

    expect(screen.getByRole("img", { name: "第一张图片.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(screen.getByRole("img", { name: "第二张图片.png" })).toBeInTheDocument();

    const stage = screen.getByRole("img", { name: "第二张图片.png" }).closest(".media-lightbox__stage");
    fireEvent.pointerDown(stage!, { pointerId: 1, clientX: 220 });
    fireEvent.pointerUp(stage!, { pointerId: 1, clientX: 110 });
    expect(screen.getByRole("img", { name: "第二张图片.png" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一张图片" })).not.toBeDisabled();
  });

  it("支持缩放控制、双击、滚轮及切换图片后的缩放重置", () => {
    render(<MediaLightbox item={firstImage} images={[firstImage, secondImage]} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "放大图片" }));
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("200%");

    const stage = screen.getByRole("img", { name: "第一张图片.png" }).closest(".media-lightbox__stage");
    fireEvent.doubleClick(stage!);
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("100%");

    fireEvent.wheel(stage!, { deltaY: -100 });
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("200%");

    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(screen.getByLabelText("当前缩放比例")).toHaveTextContent("100%");
  });

  it("关闭时保留短暂隔离层，避免点击穿透", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<MediaLightbox item={firstImage} images={[firstImage]} onClose={onClose} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "关闭全屏预览" }));
    expect(screen.getByTestId("media-lightbox-dismiss-guard")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(180);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
