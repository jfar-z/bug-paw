import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStreamingTextReveal } from "./use-streaming-text-reveal";

describe("useStreamingTextReveal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("流式源文本重组时直接显示最新内容，不清空后再追赶", () => {
    const { result, rerender } = renderHook(({ text, streaming }) => useStreamingTextReveal(text, streaming), {
      initialProps: { text: "开始\n<pi_agent_files version=\"1\">", streaming: true },
    });

    expect(result.current.visibleText).toBe("开始\n<pi_agent_files version=\"1\">");
    expect(result.current.isRevealing).toBe(true);

    rerender({ text: "开始", streaming: true });

    expect(result.current.visibleText).toBe("开始");
    expect(result.current.isRevealing).toBe(true);
  });

  it("减少动态效果时立即显示完整文本", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })));

    const { result } = renderHook(() => useStreamingTextReveal("无需动画", true));

    expect(result.current).toEqual({ visibleText: "无需动画", isRevealing: false });
  });
});
