import type { SearchProviderConfig } from "../../shared/web-research-contracts";
import type { CredentialService } from "../configuration/credential-service";
import { BochaSearchProvider } from "./bocha-search-provider";
import type { EgressProfileRegistry } from "./egress-profile-registry";
import type { ManagedSearchProviderRegistry } from "./managed-search-provider-registry";
import type { SearchProvider } from "./search-provider";
import { SearchProviderHttpClient } from "./search-provider-http-client";
import { SearxngSearchProvider } from "./searxng-search-provider";
import { TavilySearchProvider } from "./tavily-search-provider";

interface SearchProviderFactoryDependencies {
  credentials: Pick<CredentialService, "getApiKey">;
  managedProviders: ManagedSearchProviderRegistry;
  egressProfiles: EgressProfileRegistry;
  httpClient?: Pick<SearchProviderHttpClient, "requestJson">;
}

/** 根据已校验实例配置创建单一供应商 Adapter。 */
export class SearchProviderFactory {
  private readonly httpClient: Pick<SearchProviderHttpClient, "requestJson">;

  constructor(private readonly dependencies: SearchProviderFactoryDependencies) {
    this.httpClient = dependencies.httpClient ?? new SearchProviderHttpClient();
  }

  async create(config: SearchProviderConfig): Promise<SearchProvider> {
    const egressProfile = await this.dependencies.egressProfiles.require(config.egressProfileId ?? "direct");
    if (config.type === "searxng") {
      const baseUrl = config.connectionMode === "managed"
        ? this.dependencies.managedProviders.resolveManagedBaseUrl(config.id)
        : config.baseUrl;
      if (!baseUrl) throw new TypeError("SearXNG 地址尚未配置");
      return new SearxngSearchProvider(baseUrl, config.timeoutMs, async (url) => this.httpClient.requestJson({
        url: url.toString(), method: "GET", headers: {}, timeoutMs: config.timeoutMs, egressProfile,
      }), config.id);
    }
    const apiKey = await this.dependencies.credentials.getApiKey(config.id);
    return config.type === "bocha"
      ? new BochaSearchProvider(config.id, apiKey, config.timeoutMs, egressProfile, this.httpClient)
      : new TavilySearchProvider(config.id, apiKey, config.timeoutMs, egressProfile, this.httpClient);
  }
}
