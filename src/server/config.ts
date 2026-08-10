import type { PasswordRecord } from "./auth";
import type { PublicAppConfig } from "../shared/contracts";

export interface StoredProviderConfig {
  type: string;
  apiKey: string;
  baseUrl?: string;
  defaultModel: string;
}

/**
 * Web 应用用户可见的个人资料，不包含登录凭证。
 */
export interface StoredUserProfile {
  displayName?: string;
  avatar?: { mediaType: "image/png" | "image/jpeg" | "image/webp" };
}

/**
 * 当前 Web 应用配置。认证只保留密码记录，不再保存登录标识。
 */
export interface StoredAppConfigV3 {
  version: 3;
  createdAt: string;
  authentication: {
    password: PasswordRecord;
  };
  migration: {
    piConfiguration: "complete";
  };
  profile?: StoredUserProfile;
}

export type StoredAppConfig = StoredAppConfigV3;

/**
 * 只返回 Web 客户端展示所需字段，禁止泄露凭证材料。
 */
export function sanitizeAppConfig(config: StoredAppConfig): PublicAppConfig {
  return { initialized: true };
}
