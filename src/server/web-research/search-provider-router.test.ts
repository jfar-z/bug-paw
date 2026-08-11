import { describe, expect, it, vi } from "vitest";

import type { SearchProviderConfig } from "../../shared/web-research-contracts";
import type { SearchProvider, SearchProviderResult } from "./search-provider";
import { SearchProviderRouter } from "./search-provider-router";
import { SearchRunState } from "./search-run-state";

const providers: SearchProviderConfig[] = [
  { id: "primary", name: "主服务", type: "bocha", connectionMode: "official", enabled: true, timeoutMs: 5_000 },
  { id: "disabled", name: "停用服务", type: "tavily", connectionMode: "official", enabled: false, timeoutMs: 5_000 },
  { id: "fallback", name: "备用服务", type: "tavily", connectionMode: "official", enabled: true, timeoutMs: 5_000 },
];

function result(health: SearchProviderResult["health"], provider: string, count = 0): SearchProviderResult {
  return {
    health,
    results: count > 0 ? [{ title: provider, url: `https://${provider}.example`, snippet: "摘要", source: provider, publishedAt: null }] : [],
    failures: health === "healthy" ? [] : [{ provider, category: "upstream_error", retryable: true }],
  };
}

function createRouter(responses: Record<string, SearchProviderResult>) {
  const calls: string[] = [];
  const factory = {
    create: vi.fn(async (config: SearchProviderConfig): Promise<SearchProvider> => ({
      search: async () => {
        calls.push(config.id);
        return responses[config.id]!;
      },
    })),
  };
  return { router: new SearchProviderRouter(factory), factory, calls };
}

describe("搜索 Provider Router", () => {
  it("按管理员顺序跳过停用实例并在不可用时回退", async () => {
    const { router, calls } = createRouter({ primary: result("unavailable", "primary"), fallback: result("healthy", "fallback", 1) });
    const state = new SearchRunState();

    const routed = await router.search(providers, { query: "BugPaw", count: 5 }, state);

    expect(calls).toEqual(["primary", "fallback"]);
    expect(routed).toMatchObject({ health: "healthy", results: [{ title: "fallback" }] });
    expect(routed.failures).toEqual([{ provider: "primary", category: "upstream_error", retryable: true }]);
    expect(state.shouldSkip("primary")).toBe(true);
    expect(state.circuit().open).toBe(false);
  });

  it("健康空结果与带结果的降级响应都会停止回退", async () => {
    const empty = createRouter({ primary: result("healthy", "primary"), fallback: result("healthy", "fallback", 1) });
    await expect(empty.router.search(providers, { query: "none", count: 5 }, new SearchRunState())).resolves.toMatchObject({ health: "healthy", results: [] });
    expect(empty.calls).toEqual(["primary"]);

    const degraded = createRouter({ primary: result("degraded", "primary", 1), fallback: result("healthy", "fallback", 1) });
    await expect(degraded.router.search(providers, { query: "partial", count: 5 }, new SearchRunState())).resolves.toMatchObject({ health: "degraded", results: [{ title: "primary" }] });
    expect(degraded.calls).toEqual(["primary"]);
  });

  it("同一 Run 跳过已失败实例且全部不可用后打开断路", async () => {
    const { router, calls } = createRouter({ primary: result("unavailable", "primary"), fallback: result("unavailable", "fallback") });
    const state = new SearchRunState();
    state.recordUnavailable({ provider: "primary", category: "rate_limited", retryable: true });

    const routed = await router.search(providers, { query: "BugPaw", count: 5 }, state);

    expect(calls).toEqual(["fallback"]);
    expect(routed.health).toBe("unavailable");
    expect(routed.failures.map((failure) => failure.provider)).toEqual(["primary", "fallback"]);
    expect(state.circuit()).toEqual({ open: true, retryable: true });
  });
});
