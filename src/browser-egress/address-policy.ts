import { BlockList, isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

import type { BrowserEgressGrant } from "../shared/browser-worker-protocol";

/** DNS 查询返回的单个地址。 */
export interface LookupAddress {
  /** IP 地址文本。 */
  address: string;
  /** IP 版本。 */
  family: 4 | 6;
}

/** 可注入的全量 DNS 查询函数。 */
export type LookupAll = (hostname: string) => Promise<LookupAddress[]>;

/** 已授权且固定解析结果的代理目标。 */
export interface AuthorizedProxyTarget {
  /** 规范化目标 Origin。 */
  origin: string;
  /** 本次连接固定使用的 IP。 */
  address: string;
  /** IP 版本。 */
  family: 4 | 6;
  /** 目标端口。 */
  port: number;
  /** 原始主机名，用于 Host 与 TLS SNI。 */
  hostname: string;
}

/** 出口策略拒绝。 */
export class BrowserEgressPolicyError extends Error {
  /** 创建出口策略错误。 */
  constructor(readonly code: "BROWSER_PRIVATE_NETWORK_BLOCKED", message: string) {
    super(message);
    this.name = "BrowserEgressPolicyError";
  }
}

const IPV4_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) IPV4_BLOCKED.addSubnet(network, prefix, "ipv4");

const IPV6_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) IPV6_BLOCKED.addSubnet(network, prefix, "ipv6");

const METADATA_ADDRESSES = new Set(["169.254.169.254", "fd00:ec2::254"]);

/** 校验协议、Origin 和全部 DNS 结果，并固定一个可连接地址。 */
export async function authorizeProxyTarget(input: {
  protocol: "http:" | "https:";
  hostname: string;
  port: number;
  grant: BrowserEgressGrant;
  lookup?: LookupAll;
}): Promise<AuthorizedProxyTarget> {
  const hostname = stripBrackets(input.hostname).toLowerCase();
  const origin = formatOrigin(input.protocol, hostname, input.port);
  const trusted = input.grant.trustedOrigins.includes(origin);
  if (input.protocol === "http:" && !trusted) throw blocked("公开浏览只允许 HTTPS");
  const addresses = await (input.lookup ?? defaultLookup)(hostname);
  if (addresses.length === 0) throw blocked("目标域名没有可用地址");

  for (const result of addresses) {
    const metadataAddress = normalizeAddress(result.address);
    if (METADATA_ADDRESSES.has(metadataAddress)) throw blocked("云元数据地址不可访问");
    if (!trusted && isRestrictedAddress(result.address, result.family)) throw blocked("目标解析到非公网地址");
  }
  const selected = addresses[0]!;
  return { origin, address: selected.address, family: selected.family, port: input.port, hostname };
}

/** 查询主机名的全部 A/AAAA 结果；IP 字面量不再次解析。 */
async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) return [{ address: hostname, family }];
  const results = await dnsLookup(hostname, { all: true, verbatim: true });
  return results.flatMap((result) => result.family === 4 || result.family === 6
    ? [{ address: result.address, family: result.family }]
    : []);
}

/** 判断地址是否属于私网、本机、链路本地、保留或组播范围。 */
function isRestrictedAddress(address: string, family: 4 | 6): boolean {
  if (family === 4) return IPV4_BLOCKED.check(address, "ipv4");
  const mapped = mappedIpv4(address);
  if (mapped) return IPV4_BLOCKED.check(mapped, "ipv4");
  return IPV6_BLOCKED.check(address, "ipv6");
}

/** 从 IPv4-mapped IPv6 中提取 IPv4，覆盖点分和十六进制表示。 */
function mappedIpv4(address: string): string | undefined {
  const suffix = address.toLowerCase().match(/^::ffff:(.+)$/u)?.[1];
  if (!suffix) return undefined;
  if (isIP(suffix) === 4) return suffix;
  const groups = suffix.split(":");
  if (groups.length !== 2 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) return undefined;
  const high = Number.parseInt(groups[0]!, 16);
  const low = Number.parseInt(groups[1]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** 规范化地址文本用于硬编码元数据比对。 */
function normalizeAddress(address: string): string {
  return stripBrackets(address).toLowerCase();
}

/** 构建与 URL.origin 一致的精确 Origin。 */
function formatOrigin(protocol: "http:" | "https:", hostname: string, port: number): string {
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const defaultPort = protocol === "https:" ? 443 : 80;
  return `${protocol}//${host}${port === defaultPort ? "" : `:${port}`}`;
}

/** 移除 URL API 可能保留的 IPv6 方括号。 */
function stripBrackets(value: string): string {
  return value.replace(/^\[|\]$/gu, "");
}

/** 创建统一策略拒绝。 */
function blocked(message: string): BrowserEgressPolicyError {
  return new BrowserEgressPolicyError("BROWSER_PRIVATE_NETWORK_BLOCKED", message);
}
