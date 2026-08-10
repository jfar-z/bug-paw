import type { CredentialStatus } from "../../shared/configuration-contracts";
import { createVersionedJsonStore } from "./versioned-json-store";

type CredentialRecord = Record<string, Record<string, unknown>>;

/**
 * 对 Pi auth.json 执行只写凭证操作并仅公开脱敏状态。
 */
export class CredentialService {
  private readonly authPath: string;

  /**
   * 创建凭证服务。
   *
   * @param authPath Pi 原生 auth.json 路径
   */
  constructor(authPath: string) {
    this.authPath = authPath;
  }

  /**
   * 返回 auth.json 当前版本，不读取任何凭证明文。
   */
  async getRevision(): Promise<string> {
    return (await createVersionedJsonStore<CredentialRecord>(this.authPath).read()).revision;
  }

  /**
   * 读取供服务端运行时使用的目标 API Key，绝不用于 HTTP 响应。
   *
   * @param providerId Provider 标识
   */
  async getApiKey(providerId: string): Promise<string | undefined> {
    const loaded = await createVersionedJsonStore<CredentialRecord>(this.authPath).read();
    const credential = loaded.value?.[providerId];
    return credential?.type === "api_key" && typeof credential.key === "string" && credential.key
      ? credential.key
      : undefined;
  }

  /**
   * 列出不包含 key、token、env 等值的凭证状态。
   */
  async list(): Promise<CredentialStatus[]> {
    const loaded = await createVersionedJsonStore<CredentialRecord>(this.authPath).read();
    return Object.entries(loaded.value ?? {}).map(([providerId, credential]) => ({
      providerId,
      type: typeof credential.type === "string" ? credential.type : "unknown",
      configured: true,
    }));
  }

  /**
   * 设置或替换一个 Provider 的 API Key。
   *
   * @param providerId Provider 标识
   * @param key API Key 明文，仅写入 Pi 原生文件
   * @param expectedRevision 可选的调用方版本
   */
  async setApiKey(providerId: string, key: string, expectedRevision?: string): Promise<string> {
    if (!providerId.trim() || !key) {
      throw new TypeError("Provider ID 和 API Key 不能为空");
    }
    const store = createVersionedJsonStore<CredentialRecord>(this.authPath);
    const loaded = await store.read();
    const next = { ...(loaded.value ?? {}), [providerId]: { type: "api_key", key } };
    return (await store.write(next, expectedRevision ?? loaded.revision)).revision;
  }

  /**
   * 删除目标 Provider 凭证并保留其他条目。
   *
   * @param providerId Provider 标识
   * @param expectedRevision 调用方版本
   */
  async remove(providerId: string, expectedRevision: string): Promise<string> {
    const store = createVersionedJsonStore<CredentialRecord>(this.authPath);
    const loaded = await store.read();
    const next = { ...(loaded.value ?? {}) };
    delete next[providerId];
    return (await store.write(next, expectedRevision)).revision;
  }
}
