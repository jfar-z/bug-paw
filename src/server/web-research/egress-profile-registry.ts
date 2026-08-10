import { readFile } from "node:fs/promises";
import { isIP } from "node:net";

import type { WebResearchEgressProfile, WebResearchEgressProfileSummary } from "../../shared/web-research-egress-contracts";
import { WebResearchError } from "./web-research-error";

const DIRECT_PROFILE: WebResearchEgressProfile = { id: "direct", label: "直接访问", kind: "direct" };
const TRUSTED_FAKE_IP_PROFILE_ID = "trusted-fake-ip";

/** 加载部署侧只读联网出口配置，并隔离敏感连接信息。 */
export class EgressProfileRegistry {
  /** 部署侧配置文件路径；未设置时仅使用内建直连档。 */
  private readonly filePath?: string;
  /** 由启动环境变量提供的受信任 Fake-IP 网段。 */
  private readonly trustedFakeIpCidrs: string[];

  constructor(filePath?: string, trustedFakeIpCidrs?: string) {
    this.filePath = filePath;
    this.trustedFakeIpCidrs = parseTrustedFakeIpCidrs(trustedFakeIpCidrs);
  }

  /** 返回配置中心可展示的安全摘要。 */
  async listSummaries(): Promise<WebResearchEgressProfileSummary[]> {
    return (await this.readProfiles()).map(({ id, label, kind }) => ({ id, label, kind, available: true }));
  }

  /** 读取指定完整配置档；未部署时安全失败。 */
  async require(id: string): Promise<WebResearchEgressProfile> {
    const profile = (await this.readProfiles()).find((candidate) => candidate.id === id);
    if (!profile) throw new WebResearchError("WEB_EGRESS_PROFILE_UNAVAILABLE");
    return profile;
  }

  /** 外部配置不可读或非法时保留内建直连档，避免部分配置被错误信任。 */
  private async readProfiles(): Promise<WebResearchEgressProfile[]> {
    if (!this.filePath) return this.applyTrustedFakeIpProfile([DIRECT_PROFILE]);
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return this.applyTrustedFakeIpProfile([DIRECT_PROFILE, ...normalizeProfiles(value)]);
    } catch {
      return this.applyTrustedFakeIpProfile([DIRECT_PROFILE]);
    }
  }

  /** 使用部署变量覆盖内建 Fake-IP 配置档，网段从不暴露给配置中心。 */
  private applyTrustedFakeIpProfile(profiles: WebResearchEgressProfile[]): WebResearchEgressProfile[] {
    if (this.trustedFakeIpCidrs.length === 0) return profiles;
    const trustedFakeIpProfile: WebResearchEgressProfile = {
      id: TRUSTED_FAKE_IP_PROFILE_ID,
      label: "受信任 Fake-IP DNS",
      kind: "fake-ip",
      fakeIpCidrs: this.trustedFakeIpCidrs,
    };
    const existing = profiles.findIndex((profile) => profile.id === TRUSTED_FAKE_IP_PROFILE_ID);
    if (existing === -1) return [...profiles, trustedFakeIpProfile];
    return profiles.map((profile, index) => index === existing ? trustedFakeIpProfile : profile);
  }
}

/** 解析逗号分隔的启动环境变量；任意非法网段均按安全策略整体拒绝。 */
function parseTrustedFakeIpCidrs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const cidrs = value.split(",").map((cidr) => cidr.trim()).filter(Boolean);
  return cidrs.length > 0 && cidrs.every(isValidCidr) ? [...new Set(cidrs)] : [];
}

/** 校验部署文件中的完整配置，不接受覆盖内建直连档或重复标识。 */
function normalizeProfiles(value: unknown): WebResearchEgressProfile[] {
  if (!isRecord(value) || !Array.isArray(value.profiles)) throw new TypeError("出口配置格式无效");
  const profiles = value.profiles.map(normalizeProfile);
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (profile.id === "direct" || ids.has(profile.id)) throw new TypeError("出口配置标识重复");
    ids.add(profile.id);
  }
  return profiles;
}

/** 校验单个部署侧出口配置。 */
function normalizeProfile(value: unknown): WebResearchEgressProfile {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/u.test(value.id) || typeof value.label !== "string" || !value.label.trim()) {
    throw new TypeError("出口配置字段无效");
  }
  if (value.kind === "fake-ip" && Array.isArray(value.fakeIpCidrs) && value.fakeIpCidrs.length > 0 && value.fakeIpCidrs.every(isValidCidr)) {
    return { id: value.id, label: value.label.trim(), kind: "fake-ip", fakeIpCidrs: [...new Set(value.fakeIpCidrs)] };
  }
  if (value.kind === "http-proxy" && typeof value.proxyUrl === "string" && isProxyUrl(value.proxyUrl)) {
    return { id: value.id, label: value.label.trim(), kind: "http-proxy", proxyUrl: value.proxyUrl };
  }
  throw new TypeError("出口配置类型无效");
}

/** 校验 IPv4 或 IPv6 CIDR 表达式。 */
function isValidCidr(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const [address, prefix, ...rest] = value.split("/");
  if (rest.length > 0 || !address || !prefix || !/^\d+$/u.test(prefix)) return false;
  const family = isIP(address);
  return (family === 4 && Number(prefix) >= 0 && Number(prefix) <= 32) || (family === 6 && Number(prefix) >= 0 && Number(prefix) <= 128);
}

/** 仅允许部署侧提供 HTTP CONNECT 兼容代理。 */
function isProxyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && Boolean(url.hostname) && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
