import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageSpeechButton } from "./message-speech-button";

describe("MessageSpeechButton", () => {
  it("静止状态只显示喇叭 SVG 和无障碍名称", () => {
    const { container } = render(
      <MessageSpeechButton active={false} disabled={false} onToggle={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "朗读消息" });
    expect(button).toHaveAttribute("title", "朗读消息");
    expect(button).toHaveTextContent("");
    expect(container.querySelector(".lucide-volume-2")).not.toBeNull();
    expect(container.querySelector(".lucide-volume-x")).toBeNull();
  });

  it("播放中保留喇叭和声波，并提供隐藏的停止图标", () => {
    const { container } = render(
      <MessageSpeechButton active disabled={false} onToggle={vi.fn()} />,
    );

    const button = screen.getByRole("button", { name: "停止朗读" });
    expect(button).toHaveAttribute("title", "停止朗读");
    expect(button).toHaveAttribute("data-playing", "true");
    expect(button).toHaveTextContent("");
    expect(container.querySelector(".lucide-volume-2")).not.toBeNull();
    expect(container.querySelectorAll(".message-speech-button__wave")).toHaveLength(2);
    expect(container.querySelector(".lucide-volume-x")).not.toBeNull();
  });

  it("点击时只触发一次切换并传递禁用状态", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <MessageSpeechButton active={false} disabled={false} onToggle={onToggle} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(<MessageSpeechButton active={false} disabled onToggle={onToggle} />);
    const disabled = screen.getByRole("button", { name: "朗读消息" });
    expect(disabled).toBeDisabled();
    fireEvent.click(disabled);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
