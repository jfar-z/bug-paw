import { describe, expect, it } from "vitest";

import type { SearchProviderConfig } from "../../shared/web-research-contracts";
import { EgressProfileRegistry } from "./egress-profile-registry";
import { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";
import { SearchProviderFactory } from "./search-provider-factory";

describe("搜索 Provider Factory", () => {
  it.each([
    [{ id: "managed-searxng", name: "内置", type: "searxng", connectionMode: "managed", enabled: true, timeoutMs: 10_000 }, "SearxngSearchProvider"],
    [{ id: "custom", name: "自定义", type: "searxng", connectionMode: "custom", enabled: true, timeoutMs: 10_000, baseUrl: "https://search.example" }, "SearxngSearchProvider"],
    [{ id: "bocha", name: "博查", type: "bocha", connectionMode: "official", enabled: true, timeoutMs: 8_000 }, "BochaSearchProvider"],
    [{ id: "tavily", name: "Tavily", type: "tavily", connectionMode: "official", enabled: true, timeoutMs: 10_000 }, "TavilySearchProvider"],
  ] as Array<[SearchProviderConfig, string]>)("为 $type 创建正确 Adapter", async (config, className) => {
    const factory = new SearchProviderFactory({
      credentials: { getApiKey: async () => "provider-secret" },
      managedProviders: new ManagedSearchProviderRegistry(true),
      egressProfiles: new EgressProfileRegistry(),
      httpClient: { requestJson: async () => ({ results: [] }) },
    });

    expect((await factory.create(config)).constructor.name).toBe(className);
  });

  it("缺少直接 API 凭证时创建返回鉴权失败的 Provider", async () => {
    const factory = new SearchProviderFactory({
      credentials: { getApiKey: async () => undefined },
      managedProviders: new ManagedSearchProviderRegistry(true),
      egressProfiles: new EgressProfileRegistry(),
      httpClient: { requestJson: async () => ({}) },
    });
    const provider = await factory.create({ id: "bocha", name: "博查", type: "bocha", connectionMode: "official", enabled: true, timeoutMs: 8_000 });

    await expect(provider.search({ query: "BugPaw", count: 5 })).resolves.toEqual({
      health: "unavailable",
      results: [],
      failures: [{ provider: "bocha", category: "authentication", retryable: false }],
    });
  });
});
