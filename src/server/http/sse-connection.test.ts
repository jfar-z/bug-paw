// @vitest-environment node

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { SseConnection } from "./sse-connection";

describe("SseConnection", () => {
  it("write 返回 false 时等待 drain 后再发送后续事件", async () => {
    const stream = new FakeStream();
    stream.write.mockReturnValueOnce(false).mockReturnValue(true);
    const connection = new SseConnection(stream);

    const first = connection.send({ id: 1, type: "text_delta", delta: "a" });
    let completed = false;
    first.then(() => { completed = true; });
    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledOnce());
    expect(completed).toBe(false);
    stream.emit("drain");
    await first;
    await connection.send({ id: 2, type: "completed" });

    expect(stream.write).toHaveBeenCalledTimes(2);
  });

  it("连接关闭会解除仍在等待的 backpressure", async () => {
    const stream = new FakeStream();
    stream.write.mockReturnValue(false);
    const connection = new SseConnection(stream);
    const pending = connection.send({ id: 1, type: "text_delta", delta: "a" });

    connection.close();

    await expect(pending).resolves.toBeUndefined();
    expect(stream.end).toHaveBeenCalledOnce();
  });

  it("服务端终止时即使客户端永不 drain 也会销毁 Socket", async () => {
    const stream = new FakeStream();
    stream.write.mockReturnValue(false);
    const connection = new SseConnection(stream);
    const pending = connection.send({ id: 1, type: "text_delta", delta: "a" });

    connection.terminate();

    await expect(pending).resolves.toBeUndefined();
    expect(stream.end).toHaveBeenCalledOnce();
    expect(stream.destroy).toHaveBeenCalledOnce();
  });

  it("底层 Socket 在 drain 前断开时解除等待", async () => {
    const stream = new FakeStream();
    stream.write.mockReturnValue(false);
    const connection = new SseConnection(stream);
    const pending = connection.send({ id: 1, type: "text_delta", delta: "a" });

    stream.destroyed = true;
    stream.emit("close");

    await expect(pending).resolves.toBeUndefined();
    expect(stream.listenerCount("drain")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  });

  it("背压持续超过截止时间时主动关闭连接", async () => {
    vi.useFakeTimers();
    const stream = new FakeStream();
    stream.write.mockReturnValue(false);
    const connection = new SseConnection(stream, 100);
    const pending = connection.send({ id: 1, type: "text_delta", delta: "a" });

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toBeUndefined();
    expect(stream.end).toHaveBeenCalledOnce();
    expect(stream.destroy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("背压期间只排队一个心跳写入", async () => {
    const stream = new FakeStream();
    stream.write.mockReturnValueOnce(false).mockReturnValue(true);
    const connection = new SseConnection(stream);
    const first = connection.heartbeat();
    const duplicate = connection.heartbeat();

    await vi.waitFor(() => expect(stream.write).toHaveBeenCalledOnce());
    stream.emit("drain");
    await Promise.all([first, duplicate]);
    expect(stream.write).toHaveBeenCalledOnce();
  });
});

class FakeStream extends EventEmitter {
  destroyed = false;
  write = vi.fn(() => true);
  end = vi.fn();
  destroy = vi.fn();
}
