import { createHmac, timingSafeEqual } from "node:crypto";
import { request as httpRequest, createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";

import type { BrowserEgressGrant } from "../shared/browser-worker-protocol";
import { authorizeProxyTarget, type LookupAll } from "./address-policy";

/** 出口代理的运行依赖。 */
export interface BrowserEgressProxyOptions {
  /** HMAC Grant 密钥。 */
  secret: string;
  /** 可测试 DNS 查询。 */
  lookup?: LookupAll;
  /** 可测试当前时间。 */
  now?: () => number;
}

/** 签发可作为 Chromium Proxy password 使用的短期 Grant。 */
export function issueEgressGrant(grant: BrowserEgressGrant, secret: string): string {
  assertGrant(grant);
  const payload = Buffer.from(JSON.stringify(grant), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** 从 Basic Proxy-Authorization 中验证并读取 Grant。 */
export function readEgressGrant(header: string | undefined, secret: string, now = Date.now()): BrowserEgressGrant {
  if (!header?.startsWith("Basic ")) throw new Error("缺少浏览器出口授权");
  let credential: string;
  try {
    credential = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    throw new Error("浏览器出口授权无效");
  }
  const separator = credential.indexOf(":");
  if (separator < 0 || credential.slice(0, separator) !== "bugpaw") throw new Error("浏览器出口授权无效");
  const token = credential.slice(separator + 1);
  const dot = token.lastIndexOf(".");
  if (dot <= 0) throw new Error("浏览器出口授权无效");
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    throw new Error("浏览器出口授权无效");
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("浏览器出口授权无效");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    throw new Error("浏览器出口授权无效");
  }
  assertGrant(value);
  if (value.expiresAt <= now) throw new Error("浏览器出口授权已过期");
  return value;
}

/** 创建不暴露宿主端口的受控正向代理。 */
export function createBrowserEgressProxy(options: BrowserEgressProxyOptions): Server {
  const now = options.now ?? Date.now;
  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, options, now()).catch(() => {
      if (!response.headersSent) response.writeHead(403);
      response.end();
    });
  });
  server.on("connect", (request, clientSocket, head) => {
    void handleConnect(request.url ?? "", request.headers["proxy-authorization"], clientSocket, head, options, now()).catch(() => {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
  });
  server.on("upgrade", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  return server;
}

/** 转发经过校验的普通 HTTP 代理请求。 */
async function handleHttpRequest(
  incoming: import("node:http").IncomingMessage,
  outgoing: import("node:http").ServerResponse,
  options: BrowserEgressProxyOptions,
  now: number,
): Promise<void> {
  if (incoming.headers.upgrade) throw new Error("WebSocket 不允许");
  const url = new URL(incoming.url ?? "");
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("协议不允许");
  const grant = readEgressGrant(incoming.headers["proxy-authorization"], options.secret, now);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const target = await authorizeProxyTarget({ protocol: url.protocol, hostname: url.hostname, port, grant, lookup: options.lookup });
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: url.host };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const forwarded = transport({
    host: target.address,
    family: target.family,
    port: target.port,
    method: incoming.method,
    path: `${url.pathname}${url.search}`,
    headers,
    ...(url.protocol === "https:" ? { servername: target.hostname } : {}),
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  forwarded.on("error", () => outgoing.destroy());
  incoming.pipe(forwarded);
}

/** 建立固定到已校验 IP 的 HTTPS 隧道。 */
async function handleConnect(
  authority: string,
  authorization: string | undefined,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
  options: BrowserEgressProxyOptions,
  now: number,
): Promise<void> {
  const url = new URL(`https://${authority}`);
  const grant = readEgressGrant(authorization, options.secret, now);
  const port = url.port ? Number(url.port) : 443;
  const target = await authorizeProxyTarget({ protocol: "https:", hostname: url.hostname, port, grant, lookup: options.lookup });
  const upstream = netConnect({ host: target.address, port: target.port, family: target.family });
  await new Promise<void>((resolve, reject) => {
    upstream.once("connect", resolve);
    upstream.once("error", reject);
  });
  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  if (head.length > 0) upstream.write(head);
  upstream.pipe(clientSocket);
  clientSocket.pipe(upstream);
}

/** 严格校验 Grant 字段和值，拒绝向协议静默添加权限。 */
function assertGrant(value: unknown): asserts value is BrowserEgressGrant {
  if (!isRecord(value)
    || Object.keys(value).sort().join(",") !== "expiresAt,leaseId,trustedOrigins"
    || typeof value.leaseId !== "string"
    || !value.leaseId
    || !Number.isSafeInteger(value.expiresAt)
    || !Array.isArray(value.trustedOrigins)
    || value.trustedOrigins.some((origin) => typeof origin !== "string")) {
    throw new Error("浏览器出口授权字段无效");
  }
  for (const origin of value.trustedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error("浏览器出口授权包含禁止的 Origin");
    }
    const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
    if (url.origin !== origin || ["169.254.169.254", "fd00:ec2::254"].includes(hostname)) {
      throw new Error("浏览器出口授权包含禁止的 Origin");
    }
  }
}

/** 判断未知值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
