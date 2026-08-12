import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_AUTOMATION_CONFIG } from "../../shared/browser-automation-contracts";
import { BrowserResourcePool } from "./browser-resource-pool";

/** 全局浏览器资源池必须公平、可取消并能回收失联 Run。 */
describe("浏览器资源池", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("阻塞排队并在前一租约释放后按顺序授予资源", async () => {
    const onQueueUpdate = vi.fn();
    const pool = createPool();
    const first = await pool.acquire(request("agent-a", "run-a"));
    const secondPromise = pool.acquire({ ...request("agent-b", "run-b"), onQueueUpdate });

    expect(onQueueUpdate).toHaveBeenCalledWith({ position: 1, queued: 1 });
    expect(pool.status()).toMatchObject({ activeContexts: 1, queuedRequests: 1 });
    await first.release("run_completed");
    await expect(secondPromise).resolves.toMatchObject({ agentId: "agent-b", runId: "run-b" });
    await pool.close();
  });

  it("拒绝同一 Agent 重复持有或积压租约", async () => {
    const pool = createPool();
    await pool.acquire(request("agent-a", "run-a"));

    await expect(pool.acquire(request("agent-a", "run-b"))).rejects.toMatchObject({
      code: "BROWSER_AGENT_QUOTA_REACHED",
      retryable: false,
    });
    await pool.close();
  });

  it("排队超时或取消后不再占用队列", async () => {
    const pool = createPool(undefined, { orphanTimeoutMs: 60 * 60_000 });
    await pool.acquire(request("agent-a", "run-a"));
    const timedOut = pool.acquire(request("agent-b", "run-b"));
    const timedOutAssertion = expect(timedOut).rejects.toMatchObject({ code: "BROWSER_POOL_WAIT_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await timedOutAssertion;

    const controller = new AbortController();
    const cancelled = pool.acquire({ ...request("agent-c", "run-c"), signal: controller.signal });
    const cancelledAssertion = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    controller.abort(new DOMException("用户取消", "AbortError"));
    await cancelledAssertion;
    expect(pool.status().queuedRequests).toBe(0);
    await pool.close();
  });

  it("心跳延长孤儿回收但不能突破 Run 总时限", async () => {
    const closeContext = vi.fn(async () => undefined);
    const pool = createPool(closeContext);
    const lease = await pool.acquire(request("agent-a", "run-a"));

    for (let elapsed = 14; elapsed < 90; elapsed += 14) {
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      lease.heartbeat();
      expect(pool.status().activeContexts).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(pool.status().activeContexts).toBe(0);
    expect(closeContext).toHaveBeenCalledWith(lease.id, "run_timeout");
    await pool.close();
  });

  it("没有心跳时在十五分钟后回收孤儿", async () => {
    const closeContext = vi.fn(async () => undefined);
    const pool = createPool(closeContext);
    const lease = await pool.acquire(request("agent-a", "run-a"));

    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(closeContext).toHaveBeenCalledWith(lease.id, "orphan_timeout");
    expect(pool.status().activeContexts).toBe(0);
    await pool.close();
  });
});

/** 创建采用默认策略的测试资源池。 */
function createPool(
  closeContext = vi.fn(async () => undefined),
  overrides: Partial<typeof DEFAULT_BROWSER_AUTOMATION_CONFIG.pool> = {},
): BrowserResourcePool {
  return new BrowserResourcePool({ ...DEFAULT_BROWSER_AUTOMATION_CONFIG.pool, ...overrides }, { closeContext });
}

/** 创建不会主动取消的租约请求。 */
function request(agentId: string, runId: string) {
  return { agentId, runId, signal: new AbortController().signal };
}
