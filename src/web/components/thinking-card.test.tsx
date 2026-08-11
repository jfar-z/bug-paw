import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThinkingBlock } from "../conversation-timeline";
import { ThinkingCard } from "./thinking-card";

const thinking: ThinkingBlock = {
  id: "thinking-1",
  type: "thinking",
  text: "分析中",
  streaming: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThinkingCard", () => {
  it("思考中默认折叠且可手动展开，结束后保留用户选择", () => {
    const { container, rerender } = render(<ThinkingCard thinking={thinking} />);

    expect(screen.getByRole("button", { name: "展开思考详情" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("分析中").closest(".collapsible-region")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".thinking-card__status")).toHaveTextContent("思考中");
    fireEvent.click(screen.getByRole("button", { name: "展开思考详情" }));
    expect(screen.getByText("分析中")).toBeInTheDocument();
    expect(screen.getByText("分析中").closest(".collapsible-region")).toHaveAttribute("aria-hidden", "false");

    rerender(<ThinkingCard thinking={{ ...thinking, text: "分析完成", streaming: false }} />);

    expect(screen.getByRole("button", { name: "收起思考详情" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("分析完成")).toBeInTheDocument();
    expect(container.querySelector(".thinking-card__status")).toHaveTextContent("已完成");
  });

  it("流式增长时在卡片内部滚动到最新思考文本", () => {
    let pendingFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { container, rerender } = render(<ThinkingCard thinking={thinking} />);
    fireEvent.click(screen.getByRole("button", { name: "展开思考详情" }));
    const content = container.querySelector<HTMLPreElement>(".thinking-card__content");
    expect(content).not.toBeNull();
    Object.defineProperties(content!, {
      scrollHeight: { configurable: true, value: 480 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    rerender(<ThinkingCard thinking={{ ...thinking, text: "分析中，继续检查上下文" }} />);
    act(() => pendingFrame?.(16));

    expect(content!.scrollTop).toBe(480);
  });

  it("流式思考保持单一渐变状态，不为每个增量重启动画", () => {
    let pendingFrame: FrameRequestCallback | undefined;
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      pendingFrame = callback;
      return 1;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { container, rerender } = render(<ThinkingCard thinking={{ ...thinking, text: "实时" }} />);
    fireEvent.click(screen.getByRole("button", { name: "展开思考详情" }));
    rerender(<ThinkingCard thinking={{ ...thinking, text: "实时思考" }} />);

    act(() => pendingFrame?.(16));

    const content = container.querySelector(".thinking-card__content.is-text-revealing");
    expect(content).toBeInTheDocument();
    expect(content).not.toHaveClass("is-text-revealing--1");
  });

  it("只为本次新增的 Reasoning 尾部文字添加渐变", () => {
    const { container } = render(
      <ThinkingCard thinking={{ ...thinking, text: "实时思考", revealStart: 2, revealPhase: 1 }} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开思考详情" }));

    expect(container.querySelector(".streaming-text-tail--1")).toHaveTextContent("思考");
    expect(container.querySelector(".thinking-card__content")).toHaveTextContent("实时思考");
  });
});
