import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageNavigator } from "./message-navigator";

describe("MessageNavigator", () => {
  it("为每条用户 Prompt 提供带摘要的导航节点", () => {
    const targetRef = createRef<HTMLElement>();
    const scrollContainerRef = createRef<HTMLElement>();

    render(
      <MessageNavigator
        items={[
          { id: "prompt-1", summary: "检查当前工作目录", targetRef },
          { id: "prompt-2", summary: "继续检查媒体展示", targetRef },
        ]}
        scrollContainerRef={scrollContainerRef}
      />,
    );

    expect(screen.getByRole("navigation", { name: "用户消息导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳转到用户消息 1：检查当前工作目录" })).toBeInTheDocument();
    expect(screen.getByText("继续检查媒体展示")).toBeInTheDocument();
  });

  it("没有用户 Prompt 时不渲染导航", () => {
    render(<MessageNavigator items={[]} scrollContainerRef={createRef<HTMLElement>()} />);

    expect(screen.queryByRole("navigation", { name: "用户消息导航" })).not.toBeInTheDocument();
  });

  it("点击节点后滚动对话容器并标记当前项", () => {
    const container = document.createElement("div");
    const target = document.createElement("article");
    const scrollTo = vi.fn();
    Object.assign(container, { scrollTop: 120, scrollTo });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 64 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 284 } as DOMRect);

    render(
      <MessageNavigator
        items={[{ id: "prompt-1", summary: "检查当前工作目录", targetRef: { current: target } }]}
        scrollContainerRef={{ current: container }}
      />,
    );

    const button = screen.getByRole("button", { name: "跳转到用户消息 1：检查当前工作目录" });
    fireEvent.click(button);

    expect(scrollTo).toHaveBeenCalledWith({ top: 308, behavior: "smooth" });
    expect(button).toHaveAttribute("aria-current", "location");
  });

  it("支持通过稳定 DOM ID 定位动态用户消息", () => {
    const container = document.createElement("div");
    const target = document.createElement("article");
    target.id = "live-user-message-1";
    container.append(target);
    const scrollTo = vi.fn();
    Object.assign(container, { scrollTop: 20, scrollTo });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 40 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 160 } as DOMRect);

    render(
      <MessageNavigator
        items={[{ id: "prompt-1", summary: "动态消息", targetId: "live-user-message-1" }]}
        scrollContainerRef={{ current: container }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "跳转到用户消息 1：动态消息" }));

    expect(scrollTo).toHaveBeenCalledWith({ top: 108, behavior: "smooth" });
  });
});
