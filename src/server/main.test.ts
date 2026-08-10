import { describe, expect, it, vi } from "vitest";

import { createGracefulShutdown } from "./main";

describe("服务优雅关闭", () => {
  it("多个终止信号只执行一次关闭并以成功状态退出", async () => {
    let finishClose: (() => void) | undefined;
    const close = vi.fn(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    const exit = vi.fn();
    const logError = vi.fn();
    const shutdown = createGracefulShutdown({ close, logError, exit });

    const first = shutdown();
    const second = shutdown();
    expect(second).toBe(first);
    expect(close).toHaveBeenCalledOnce();

    finishClose?.();
    await first;

    expect(exit).toHaveBeenCalledWith(0);
    expect(logError).not.toHaveBeenCalled();
  });

  it("关闭失败时记录错误并以失败状态退出", async () => {
    const error = new Error("close failed");
    const close = vi.fn().mockRejectedValue(error);
    const exit = vi.fn();
    const logError = vi.fn();
    const shutdown = createGracefulShutdown({ close, logError, exit });

    await shutdown();

    expect(logError).toHaveBeenCalledWith(error, "服务关闭失败");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
