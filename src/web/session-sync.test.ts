import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionListSync } from "./session-sync";

class FakeBroadcastChannel {
  static channels: FakeBroadcastChannel[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn();

  constructor(readonly name: string) {
    FakeBroadcastChannel.channels.push(this);
  }

  postMessage(data: unknown): void {
    FakeBroadcastChannel.channels
      .filter((channel) => channel !== this && channel.name === this.name)
      .forEach((channel) => channel.onmessage?.({ data } as MessageEvent));
  }
}

describe("createSessionListSync", () => {
  afterEach(() => {
    FakeBroadcastChannel.channels = [];
    vi.unstubAllGlobals();
  });

  it("向同源其他标签页广播会话列表失效事件", () => {
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    const firstInvalidated = vi.fn();
    const secondInvalidated = vi.fn();
    const first = createSessionListSync(firstInvalidated);
    const second = createSessionListSync(secondInvalidated);

    first.notify();

    expect(firstInvalidated).not.toHaveBeenCalled();
    expect(secondInvalidated).toHaveBeenCalledOnce();
    first.close();
    second.close();
  });
});
