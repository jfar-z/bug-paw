import { act, fireEvent, render } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMessageAutofollow, type MessageAutofollowControls } from "./use-message-autofollow";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly disconnect = vi.fn();
  readonly observe = vi.fn();

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  emit() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

interface HarnessProps {
  version: number;
  onControls: (controls: MessageAutofollowControls) => void;
}

function Harness({ version, onControls }: HarnessProps) {
  const controls = useMessageAutofollow(version);
  useLayoutEffect(() => onControls(controls), [controls, onControls]);
  return <div data-testid="scroll" ref={controls.scrollContainerRef}><div ref={controls.contentRef} /></div>;
}

function setScrollMetrics(element: HTMLElement, values: { clientHeight: number; scrollHeight: number; scrollTop: number }) {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: values.clientHeight },
    scrollHeight: { configurable: true, value: values.scrollHeight },
    scrollTop: { configurable: true, writable: true, value: values.scrollTop },
  });
}

beforeEach(() => {
  FakeResizeObserver.instances = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useMessageAutofollow", () => {
  it("时间线快速增长时直接跟到最新底部", () => {
    let controls: MessageAutofollowControls | undefined;
    const onControls = (next: MessageAutofollowControls) => { controls = next; };
    const view = render(<Harness version={0} onControls={onControls} />);
    const scroll = view.getByTestId("scroll");
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 900, scrollTop: 600 });

    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 960, scrollTop: 600 });
    view.rerender(<Harness version={1} onControls={onControls} />);

    expect(controls).toBeDefined();
    expect(scroll.scrollTop).toBe(960);
  });

  it("异步内容增高时在跟随状态下贴底", () => {
    const view = render(<Harness version={0} onControls={() => undefined} />);
    const scroll = view.getByTestId("scroll");
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 900, scrollTop: 600 });
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 1100, scrollTop: 600 });

    act(() => FakeResizeObserver.instances[0].emit());

    expect(scroll.scrollTop).toBe(1100);
  });

  it("切换会话后只在新内容提交时对齐一次", () => {
    let controls: MessageAutofollowControls | undefined;
    const onControls = (next: MessageAutofollowControls) => { controls = next; };
    const view = render(<Harness version={0} onControls={onControls} />);
    const scroll = view.getByTestId("scroll");
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 900, scrollTop: 400 });

    act(() => controls!.alignAfterNextContentCommit());
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 1100, scrollTop: 400 });
    view.rerender(<Harness version={1} onControls={onControls} />);
    expect(scroll.scrollTop).toBe(1100);

    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 1280, scrollTop: 1100 });
    act(() => FakeResizeObserver.instances[0].emit());
    expect(scroll.scrollTop).toBe(1100);
  });

  it("用户主动上滚后暂停跟随，回到底部附近后恢复", () => {
    const view = render(<Harness version={0} onControls={() => undefined} />);
    const scroll = view.getByTestId("scroll");
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 900, scrollTop: 400 });
    fireEvent.scroll(scroll);

    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 1000, scrollTop: 400 });
    view.rerender(<Harness version={1} onControls={() => undefined} />);
    act(() => FakeResizeObserver.instances[0].emit());
    expect(scroll.scrollTop).toBe(400);

    scroll.scrollTop = 660;
    fireEvent.scroll(scroll);
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 1080, scrollTop: 660 });
    act(() => FakeResizeObserver.instances[0].emit());
    expect(scroll.scrollTop).toBe(1080);
  });

  it("发送消息可以恢复已经暂停的跟随", () => {
    let controls: MessageAutofollowControls | undefined;
    const view = render(<Harness version={0} onControls={(next) => { controls = next; }} />);
    const scroll = view.getByTestId("scroll");
    setScrollMetrics(scroll, { clientHeight: 300, scrollHeight: 1000, scrollTop: 400 });
    fireEvent.scroll(scroll);

    act(() => controls!.resumeFollowing());

    expect(scroll.scrollTop).toBe(1000);
  });

  it("卸载时停止观察异步高度变化", () => {
    const view = render(<Harness version={0} onControls={() => undefined} />);
    const observer = FakeResizeObserver.instances[0];

    view.unmount();

    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
