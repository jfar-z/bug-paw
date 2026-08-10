import type { FastifyInstance, FastifyRequest } from "fastify";

import { sendApiError } from "./http";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 为浏览器修改请求校验 Origin/Referer，阻止 Cookie 会话被跨站调用。
 */
export function registerOriginProtection(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    if (SAFE_METHODS.has(request.method) || !request.url.startsWith("/api/")) return;
    const origin = header(request, "origin");
    const referer = header(request, "referer");
    const fetchSite = header(request, "sec-fetch-site");
    const browserRequest = fetchSite !== undefined || header(request, "sec-fetch-mode") !== undefined;
    const suppliedOrigin = origin ?? originFromReferer(referer);

    if (!suppliedOrigin) {
      if (browserRequest) return sendApiError(reply, 403, "ORIGIN_REJECTED", "浏览器修改请求缺少来源信息");
      return;
    }
    const expectedOrigin = `${request.protocol}://${request.headers.host ?? ""}`;
    const proxyTerminatedSameOrigin = fetchSite === "same-origin" && sameAuthority(suppliedOrigin, request.headers.host);
    if ((!proxyTerminatedSameOrigin && normalizeOrigin(suppliedOrigin) !== normalizeOrigin(expectedOrigin)) || fetchSite === "cross-site") {
      return sendApiError(reply, 403, "ORIGIN_REJECTED", "拒绝跨来源修改请求");
    }
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (isSensitiveConfigurationPath(request.url)) reply.header("Cache-Control", "no-store");
    return payload;
  });
}

function isSensitiveConfigurationPath(url: string): boolean {
  // 安全策略统一基于无版本路径判断，避免新增 API namespace 时绕过缓存保护。
  const normalized = url.replace(/^\/api\/v1(?=\/|\?|$)/u, "/api");
  return normalized.startsWith("/api/configuration")
    || normalized.startsWith("/api/providers")
    || normalized.startsWith("/api/resources")
    || normalized.startsWith("/api/knowledge-bases")
    || (/^\/api\/agents(?:\/|\?|$)/u.test(normalized)
      && !normalized.includes("/avatar")
      && !normalized.includes("/files"));
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function originFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try { return new URL(referer).origin; }
  catch { return undefined; }
}

function normalizeOrigin(value: string): string {
  try { return new URL(value).origin.toLowerCase(); }
  catch { return "invalid"; }
}

function sameAuthority(origin: string, host: string | undefined): boolean {
  if (!host) return false;
  try { return new URL(origin).host.toLowerCase() === host.toLowerCase(); }
  catch { return false; }
}
