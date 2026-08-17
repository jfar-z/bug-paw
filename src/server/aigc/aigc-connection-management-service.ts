import type {
  AigcChannelConfig,
  AigcChannelTemplate,
  AigcCreateChannelInput,
  AigcSettingsDocument,
  AigcUpdateChannelInput,
} from "../../shared/aigc-contracts";
import type { ConfigTransactionService } from "../configuration/config-transaction";
import type { CredentialService } from "../configuration/credential-service";
import { createVersionedJsonStore, VersionConflictError } from "../configuration/versioned-json-store";
import { toAigcChannelSummary, type AigcConnectionService } from "./aigc-connection-service";

type CredentialRecord = Record<string, Record<string, unknown>>;

export const AIGC_CHANNEL_TEMPLATES: AigcChannelTemplate[] = [
  { id: "openai", name: "OpenAI", type: "openai", defaultBaseUrl: "https://api.openai.com/v1", credentialOptional: false },
  { id: "grok", name: "Grok", type: "grok", defaultBaseUrl: "https://api.x.ai/v1", credentialOptional: false },
  { id: "comfyui", name: "ComfyUI", type: "comfyui", defaultBaseUrl: "http://127.0.0.1:8188", credentialOptional: true },
];

interface AigcConnectionManagementDependencies {
  connections: AigcConnectionService;
  credentials: CredentialService;
  configPath: string;
  authPath: string;
  transaction: ConfigTransactionService;
}

/** 协调 AIGC 渠道配置与独立凭证文件的多文件变更。 */
export class AigcConnectionManagementService {
  /**
   * @param dependencies AIGC 渠道管理依赖
   */
  constructor(private readonly dependencies: AigcConnectionManagementDependencies) {}

  /** 读取包含渠道、模板和脱敏凭证状态的完整文档。 */
  async document(): Promise<AigcSettingsDocument> {
    const [document, credentials, credentialRevision] = await Promise.all([
      this.dependencies.connections.read(),
      this.dependencies.credentials.list(),
      this.dependencies.credentials.getRevision(),
    ]);
    const configured = new Set(credentials.map((status) => status.providerId));
    return {
      revision: document.revision,
      channels: document.channels.map((channel) => toAigcChannelSummary(channel, configured.has(channel.id))),
      channelTemplates: AIGC_CHANNEL_TEMPLATES,
      credentials,
      credentialRevision,
    };
  }

  /** 原子新增渠道与可选凭证。 */
  async add(input: AigcCreateChannelInput): Promise<void> {
    const [current, credentials] = await this.readCurrentState();
    this.assertRevisions(input.configRevision, input.credentialRevision, current.revision, credentials.revision);
    if (current.channels.some((candidate) => candidate.id === input.channel.id)) {
      throw new TypeError("AIGC 渠道标识重复");
    }
    const nextConfig = await this.dependencies.connections.validate({
      name: input.channel.name,
      type: input.channel.type,
      baseUrl: input.channel.baseUrl,
      enabled: input.channel.enabled,
      timeoutMs: input.channel.timeoutMs,
    }, input.channel.id);
    const nextCredentials = { ...(credentials.value ?? {}) };
    if (input.apiKey !== undefined) this.setApiKey(nextCredentials, input.channel.id, input.apiKey);
    this.assertCredentialPolicy(nextConfig, nextCredentials);
    await this.writeState({ channels: [...current.channels, nextConfig] }, nextCredentials, input.configRevision, input.credentialRevision);
  }

  /** 原子编辑渠道配置与凭证，身份字段创建后不可变。 */
  async update(id: string, input: AigcUpdateChannelInput): Promise<void> {
    const [current, credentials] = await this.readCurrentState();
    this.assertRevisions(input.configRevision, input.credentialRevision, current.revision, credentials.revision);
    const previous = current.channels.find((channel) => channel.id === id);
    if (!previous) throw new TypeError("AIGC 渠道不存在");
    if (input.channel.id !== id || input.channel.type !== previous.type) {
      throw new TypeError("AIGC 渠道身份字段不可修改");
    }
    const nextConfig = await this.dependencies.connections.validate({
      name: input.channel.name,
      type: input.channel.type,
      baseUrl: input.channel.baseUrl,
      enabled: input.channel.enabled,
      timeoutMs: input.channel.timeoutMs,
    }, id);
    const nextCredentials = { ...(credentials.value ?? {}) };
    if (input.credential.action === "replace") {
      this.setApiKey(nextCredentials, id, input.credential.apiKey);
    } else if (input.credential.action === "remove") {
      delete nextCredentials[id];
    }
    this.assertCredentialPolicy(nextConfig, nextCredentials);
    await this.writeState({
      channels: current.channels.map((channel) => channel.id === id ? nextConfig : channel),
    }, nextCredentials, input.configRevision, input.credentialRevision);
  }

  /** 原子删除渠道及对应凭证。 */
  async remove(id: string, configRevision: string, credentialRevision: string): Promise<void> {
    const [current, credentials] = await this.readCurrentState();
    this.assertRevisions(configRevision, credentialRevision, current.revision, credentials.revision);
    if (!current.channels.some((channel) => channel.id === id)) throw new TypeError("AIGC 渠道不存在");
    const nextCredentials = { ...(credentials.value ?? {}) };
    delete nextCredentials[id];
    await this.writeState({
      channels: current.channels.filter((channel) => channel.id !== id),
    }, nextCredentials, configRevision, credentialRevision);
  }

  /** 同时读取配置和凭证，以便在事务前校验两份版本。 */
  private async readCurrentState() {
    return Promise.all([
      this.dependencies.connections.read(),
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

  /** OpenAI/Grok 必须保留有效凭证，ComfyUI 允许匿名。 */
  private assertCredentialPolicy(channel: AigcChannelConfig, credentials: CredentialRecord): void {
    const template = AIGC_CHANNEL_TEMPLATES.find((item) => item.type === channel.type);
    if (!template?.credentialOptional) {
      const credential = credentials[channel.id];
      if (credential?.type !== "api_key" || typeof credential.key !== "string" || !credential.key) {
        throw new TypeError(`${template?.name ?? channel.type} 渠道必须配置 API Key`);
      }
    }
  }

  /** 通过同一事务提交配置和凭证快照。 */
  private async writeState(
    nextConfig: { channels: AigcChannelConfig[] },
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
