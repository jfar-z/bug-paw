import type { SearchProviderConfig } from "../../shared/web-research-contracts";
import type { SearchProviderFactory } from "./search-provider-factory";
import type { SearchProviderFailure, SearchProviderInput, SearchProviderResult } from "./search-provider";
import { SearchRunState } from "./search-run-state";

interface SearchProviderFactoryLike {
  create(config: SearchProviderConfig): ReturnType<SearchProviderFactory["create"]>;
}

/** 按管理员配置顺序执行故障切换，且不向 Agent 暴露供应商选择权。 */
export class SearchProviderRouter {
  constructor(private readonly factory: SearchProviderFactoryLike) {}

  /** 搜索所有可用候选；健康空结果和带结果的降级响应均视为有效终点。 */
  async search(configs: SearchProviderConfig[], input: SearchProviderInput, state = new SearchRunState()): Promise<SearchProviderResult> {
    for (const config of configs) {
      if (!config.enabled || state.shouldSkip(config.id)) continue;
      const providerResult = await this.searchOne(config, input);
      if (providerResult.health === "unavailable" || (providerResult.health === "degraded" && providerResult.results.length === 0)) {
        const failures = providerResult.failures.length > 0
          ? providerResult.failures
          : [this.upstreamFailure(config.id)];
        for (const failure of failures) state.recordUnavailable({ ...failure, provider: config.id });
        continue;
      }
      return {
        health: providerResult.health,
        results: providerResult.results,
        failures: [...state.failures(), ...providerResult.failures],
      };
    }

    state.openCircuit();
    return { health: "unavailable", results: [], failures: state.failures() };
  }

  private async searchOne(config: SearchProviderConfig, input: SearchProviderInput): Promise<SearchProviderResult> {
    try {
      return await (await this.factory.create(config)).search(input);
    } catch {
      // Factory 异常可能来自部署地址或出口变化，统一按脱敏上游故障参与回退。
      return { health: "unavailable", results: [], failures: [this.upstreamFailure(config.id)] };
    }
  }

  private upstreamFailure(providerId: string): SearchProviderFailure {
    return { provider: providerId, category: "upstream_error", retryable: true };
  }
}
