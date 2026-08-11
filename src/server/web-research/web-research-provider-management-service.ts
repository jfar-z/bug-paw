import type { SearchProviderConfig, WebResearchConfig, WebResearchConfigDocument } from "../../shared/web-research-contracts";
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

  /** 在配置 revision 匹配时追加一个已校验实例。 */
  async add(provider: SearchProviderConfig, revision: string): Promise<WebResearchConfigDocument> {
    const current = await this.dependencies.configs.read();
    if (current.revision !== revision) throw new VersionConflictError(revision, current.revision);
    if (current.config.searchProviders.some((candidate) => candidate.id === provider.id)) {
      throw new TypeError("搜索服务标识重复");
    }
    return this.dependencies.configs.update({
      ...current.config,
      searchProviders: [...current.config.searchProviders, provider],
    }, revision);
  }

  /** 原子删除实例与对应凭证；受管容器不属于操作范围。 */
  async remove(providerId: string, configRevision: string, credentialRevision: string): Promise<void> {
    const [current, credentials] = await Promise.all([
      this.dependencies.configs.read(),
      createVersionedJsonStore<CredentialRecord>(this.dependencies.authPath).read(),
    ]);
    if (current.revision !== configRevision) throw new VersionConflictError(configRevision, current.revision);
    if (credentials.revision !== credentialRevision) throw new VersionConflictError(credentialRevision, credentials.revision);
    if (!current.config.searchProviders.some((provider) => provider.id === providerId)) throw new TypeError("搜索服务不存在");

    const nextConfig: WebResearchConfig = await this.dependencies.configs.validate({
      ...current.config,
      searchProviders: current.config.searchProviders.filter((provider) => provider.id !== providerId),
    });
    const nextCredentials = { ...(credentials.value ?? {}) };
    delete nextCredentials[providerId];

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
