import type {
  CreateSearchProviderInput,
  ReorderSearchProvidersInput,
  SearchProviderConfig,
  UpdateSearchProviderInput,
  WebResearchConfig,
  WebResearchConfigDocument,
} from "../../shared/web-research-contracts";
import type { ConfigTransactionService } from "../configuration/config-transaction";
import type { CredentialService } from "../configuration/credential-service";
import { createVersionedJsonStore, VersionConflictError } from "../configuration/versioned-json-store";
import type { WebResearchConfigService } from "./web-research-config-service";

type CredentialRecord = Record<string, Record<string, unknown>>;

interface ProviderManagementDependencies {
  configs: WebResearchConfigService;
  credentials: CredentialService;
  configPath: string;
  authPath: string;
  transaction: ConfigTransactionService;
}

/** 协调搜索实例配置与独立凭证文件的多文件变更。 */
export class WebResearchProviderManagementService {
  constructor(private readonly dependencies: ProviderManagementDependencies) {}

  /** 原子新增渠道与可选凭证。 */
  async add(input: CreateSearchProviderInput): Promise<void> {
    const [current, credentials] = await this.readCurrentState();
    this.assertRevisions(input.configRevision, input.credentialRevision, current.revision, credentials.revision);
    if (current.config.searchProviders.some((candidate) => candidate.id === input.provider.id)) {
      throw new TypeError("搜索服务标识重复");
    }
    const nextConfig = await this.dependencies.configs.validate({
      ...current.config,
      searchProviders: [...current.config.searchProviders, input.provider],
    });
    const nextCredentials = { ...(credentials.value ?? {}) };
    if (input.apiKey !== undefined) this.setApiKey(nextCredentials, input.provider.id, input.apiKey);
    this.assertEnabledProviderCredential(input.provider, nextCredentials);
    await this.writeState(nextConfig, nextCredentials, input.configRevision, input.credentialRevision);
  }

  /** 原子编辑渠道配置与凭证，身份字段创建后不可变。 */
  async update(providerId: string, input: UpdateSearchProviderInput): Promise<void> {
    const [current, credentials] = await this.readCurrentState();
    this.assertRevisions(input.configRevision, input.credentialRevision, current.revision, credentials.revision);
    const previous = current.config.searchProviders.find((provider) => provider.id === providerId);
    if (!previous) throw new TypeError("搜索服务不存在");
    if (input.provider.id !== providerId
      || input.provider.type !== previous.type
      || input.provider.connectionMode !== previous.connectionMode) {
      throw new TypeError("搜索服务身份字段不可修改");
    }

    const nextCredentials = { ...(credentials.value ?? {}) };
    if (input.credential.action === "replace") {
      this.setApiKey(nextCredentials, providerId, input.credential.apiKey);
    } else if (input.credential.action === "remove") {
      delete nextCredentials[providerId];
    }
    this.assertEnabledProviderCredential(input.provider, nextCredentials);
    const nextConfig = await this.dependencies.configs.validate({
      ...current.config,
      searchProviders: current.config.searchProviders.map((provider) => provider.id === providerId ? input.provider : provider),
    });
    await this.writeState(nextConfig, nextCredentials, input.configRevision, input.credentialRevision);
  }

  /** 保存包含全部现有渠道的优先级顺序。 */
  async reorder(input: ReorderSearchProvidersInput): Promise<WebResearchConfigDocument> {
    const current = await this.dependencies.configs.read();
    if (current.revision !== input.revision) throw new VersionConflictError(input.revision, current.revision);
    const currentIds = current.config.searchProviders.map(({ id }) => id);
    const requestedIds = new Set(input.providerIds);
    if (input.providerIds.length !== currentIds.length
      || requestedIds.size !== currentIds.length
      || currentIds.some((id) => !requestedIds.has(id))) {
      throw new TypeError("渠道顺序必须是现有渠道的完整排列");
    }
    const providersById = new Map(current.config.searchProviders.map((provider) => [provider.id, provider]));
    return this.dependencies.configs.update({
      ...current.config,
      searchProviders: input.providerIds.map((id) => providersById.get(id) as SearchProviderConfig),
    }, input.revision);
  }

  /** 原子删除实例与对应凭证；受管容器不属于操作范围。 */
  async remove(providerId: string, configRevision: string, credentialRevision: string): Promise<void> {
    const [current, credentials] = await this.readCurrentState();
    this.assertRevisions(configRevision, credentialRevision, current.revision, credentials.revision);
    if (!current.config.searchProviders.some((provider) => provider.id === providerId)) throw new TypeError("搜索服务不存在");

    const nextConfig: WebResearchConfig = await this.dependencies.configs.validate({
      ...current.config,
      searchProviders: current.config.searchProviders.filter((provider) => provider.id !== providerId),
    });
    const nextCredentials = { ...(credentials.value ?? {}) };
    delete nextCredentials[providerId];

    await this.writeState(nextConfig, nextCredentials, configRevision, credentialRevision);
  }

  /** 同时读取配置和凭证，以便在事务前校验两份版本。 */
  private async readCurrentState() {
    return Promise.all([
      this.dependencies.configs.read(),
      createVersionedJsonStore<CredentialRecord>(this.dependencies.authPath).read(),
    ]);
  }

  /** 在任何写入发生前校验配置与凭证版本。 */
  private assertRevisions(
    expectedConfig: string,
    expectedCredential: string,
    actualConfig: string,
    actualCredential: string,
  ): void {
    if (actualConfig !== expectedConfig) throw new VersionConflictError(expectedConfig, actualConfig);
    if (actualCredential !== expectedCredential) throw new VersionConflictError(expectedCredential, actualCredential);
  }

  /** 把非空 API Key 写入下一份凭证快照。 */
  private setApiKey(credentials: CredentialRecord, providerId: string, apiKey: string): void {
    if (!apiKey) throw new TypeError("API Key 不能为空");
    credentials[providerId] = { type: "api_key", key: apiKey };
  }

  /** 直连搜索渠道启用时必须同时具备有效凭证。 */
  private assertEnabledProviderCredential(provider: SearchProviderConfig, credentials: CredentialRecord): void {
    const credential = credentials[provider.id];
    if (provider.enabled
      && provider.type !== "searxng"
      && (credential?.type !== "api_key" || typeof credential.key !== "string" || !credential.key)) {
      throw new TypeError("启用直连搜索服务前必须配置凭证");
    }
  }

  /** 通过同一事务提交配置和凭证快照。 */
  private async writeState(
    nextConfig: WebResearchConfig,
    nextCredentials: CredentialRecord,
    configRevision: string,
    credentialRevision: string,
  ): Promise<void> {
    await this.dependencies.transaction.run([
      {
        path: this.dependencies.configPath,
        expectedRevision: configRevision,
        nextContent: serialize(nextConfig),
        sensitive: false,
      },
      {
        path: this.dependencies.authPath,
        expectedRevision: credentialRevision,
        nextContent: Object.keys(nextCredentials).length > 0 ? serialize(nextCredentials) : null,
        sensitive: true,
      },
    ]);
  }
}

/** 与项目原子 JSON 写入器保持相同的紧凑格式和结尾换行。 */
function serialize(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
