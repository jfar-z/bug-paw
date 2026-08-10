import type { EventEmitter } from "node:events";

interface WritableSseStream extends EventEmitter {
  destroyed: boolean;
  write(chunk: string): boolean;
  end(): void;
  destroy?(error?: Error): void;
}

/** 尊重 Node Stream backpressure 的 SSE 输出适配器。 */
export class SseConnection {
  private closed = false;
  private heartbeatPending = false;
  private writeTail: Promise<void> = Promise.resolve();
  private readonly drainWaiters = new Set<() => void>();
  private resolveTerminated: () => void = () => undefined;
  /** 连接主动关闭、底层断开或背压超时后完成。 */
  readonly terminated = new Promise<void>((resolve) => { this.resolveTerminated = resolve; });

  constructor(
    private readonly stream: WritableSseStream,
    private readonly drainTimeoutMs = 15_000,
  ) {}

  async send<T extends { id?: number; type: string }>(event: T): Promise<void> {
    const prefix = event.id === undefined ? "" : `id: ${event.id}\n`;
    await this.enqueue(`${prefix}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }

  /** 发送使用默认 message 事件类型的数据，兼容只监听 EventSource.onmessage 的页面。 */
  async sendData(value: unknown): Promise<void> {
    await this.enqueue(`data: ${JSON.stringify(value)}\n\n`);
  }

  async heartbeat(): Promise<void> {
    if (this.heartbeatPending) return;
    this.heartbeatPending = true;
    try {
      await this.enqueue(": heartbeat\n\n");
    } finally {
      this.heartbeatPending = false;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveTerminated();
    this.drainWaiters.forEach((resolve) => resolve());
    this.drainWaiters.clear();
    if (!this.stream.destroyed) this.stream.end();
  }

  /** 服务端判定连接不可继续时强制释放 Socket，不能等待慢客户端消费 FIN。 */
  terminate(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveTerminated();
    this.drainWaiters.forEach((resolve) => resolve());
    this.drainWaiters.clear();
    if (!this.stream.destroyed) {
      this.stream.end();
      this.stream.destroy?.();
    }
  }

  /** 串行写入事件与心跳，避免同一 Socket 上的背压等待无限堆积。 */
  private enqueue(chunk: string): Promise<void> {
    const operation = this.writeTail.catch(() => undefined).then(async () => {
      if (this.closed || this.stream.destroyed) return;
      if (!this.stream.write(chunk)) await this.waitForDrain();
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }

  private waitForDrain(): Promise<void> {
    if (this.closed || this.stream.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const complete = () => {
        clearTimeout(timeout);
        this.drainWaiters.delete(complete);
        this.stream.removeListener("drain", complete);
        this.stream.removeListener("close", complete);
        this.stream.removeListener("error", complete);
        this.stream.removeListener("aborted", complete);
        resolve();
      };
      this.drainWaiters.add(complete);
      this.stream.once("drain", complete);
      this.stream.once("close", complete);
      this.stream.once("error", complete);
      this.stream.once("aborted", complete);
      const timeout = setTimeout(() => {
        // 已持续背压的 Socket 不再承载可交付数据，强制销毁以释放服务端资源。
        this.terminate();
      }, this.drainTimeoutMs);
      timeout.unref();
    });
  }
}
