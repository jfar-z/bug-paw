import type { SearchProviderTemplate } from "../../shared/web-research-contracts";

const MANAGED_SEARXNG_ID = "managed-searxng";
const MANAGED_SEARXNG_BASE_URL = "http://bug-paw-search:8080";

/** 隔离部署层搜索服务寻址，配置中心只接触不含内部地址的模板。 */
export class ManagedSearchProviderRegistry {
  constructor(private readonly available: boolean) {}

  /** 返回当前部署可添加的受管服务模板。 */
  listTemplates(): SearchProviderTemplate[] {
    return this.available
      ? [{ id: MANAGED_SEARXNG_ID, name: "内置 SearXNG", type: "searxng", connectionMode: "managed" }]
      : [];
  }

  /** 仅在当前部署确实提供目标服务时解析内部地址。 */
  resolveManagedBaseUrl(providerId: string): string {
    if (!this.available || providerId !== MANAGED_SEARXNG_ID) {
      throw new Error("受管搜索服务不可用");
    }
    return MANAGED_SEARXNG_BASE_URL;
  }
}
