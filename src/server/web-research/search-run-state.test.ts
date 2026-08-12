import { describe, expect, it } from "vitest";

import { SearchRunState } from "./search-run-state";

describe("搜索 Run 状态", () => {
  it("记录失败实例与断路事实并可在新 Run 重置", () => {
    const state = new SearchRunState();
    state.recordUnavailable({ provider: "primary", category: "rate_limited", retryable: true, retryAfterMs: 3_000 });
    state.openCircuit();

    expect(state.shouldSkip("primary")).toBe(true);
    expect(state.failures()).toEqual([{ provider: "primary", category: "rate_limited", retryable: true, retryAfterMs: 3_000 }]);
    expect(state.circuit()).toEqual({ open: true, retryable: true });

    state.reset();

    expect(state.shouldSkip("primary")).toBe(false);
    expect(state.failures()).toEqual([]);
    expect(state.circuit()).toEqual({ open: false, retryable: false });
  });

  it("任一候选存在瞬时失败时允许后续新 Run 重试", () => {
    const state = new SearchRunState();
    state.recordUnavailable({ provider: "primary", category: "authentication", retryable: false });
    state.recordUnavailable({ provider: "fallback", category: "timeout", retryable: true });
    state.openCircuit();

    expect(state.circuit()).toEqual({ open: true, retryable: true });
  });
});
