import { describe, expect, it } from "vitest";

import { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";

describe("受管搜索服务注册表", () => {
  it("部署提供搜索服务时只返回不含内部地址的模板", () => {
    const registry = new ManagedSearchProviderRegistry(true);

    expect(registry.listTemplates()).toEqual([{
      id: "managed-searxng",
      name: "内置 SearXNG",
      type: "searxng",
      connectionMode: "managed",
    }]);
    expect(JSON.stringify(registry.listTemplates())).not.toContain("8080");
  });

  it("核心部署不伪造受管搜索模板", () => {
    expect(new ManagedSearchProviderRegistry(false).listTemplates()).toEqual([]);
  });

  it("只在服务可用且标识匹配时解析内部地址", () => {
    expect(new ManagedSearchProviderRegistry(true).resolveManagedBaseUrl("managed-searxng")).toBe("http://bug-paw-search:8080");
    expect(() => new ManagedSearchProviderRegistry(false).resolveManagedBaseUrl("managed-searxng")).toThrow("受管搜索服务不可用");
    expect(() => new ManagedSearchProviderRegistry(true).resolveManagedBaseUrl("unknown")).toThrow("受管搜索服务不可用");
  });
});
