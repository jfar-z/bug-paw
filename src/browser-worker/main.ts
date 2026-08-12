import { readFile } from "node:fs/promises";

import { chromium, type Browser } from "playwright";

import { issueEgressGrant } from "../browser-egress/proxy-server";
import { createBrowserWorkerApp } from "./app";
import { BrowserSession } from "./browser-session";

/** 启动固定 Chromium 版本的浏览器 Worker。 */
async function start(): Promise<void> {
  const secretPath = process.env.BUG_PAW_BROWSER_TOKEN_FILE;
  const proxyServer = process.env.BUG_PAW_BROWSER_PROXY_SERVER;
  if (!secretPath || !proxyServer) throw new Error("缺少浏览器 Worker 内部配置");
  const secret = (await readFile(secretPath, "utf8")).trim();
  if (!secret) throw new Error("浏览器内部通信密钥为空");
  let browser: Browser = await launchBrowser();
  const server = createBrowserWorkerApp({
    secret,
    createSession: async (input) => {
      if (!browser.isConnected()) browser = await launchBrowser();
      const proxyGrant = issueEgressGrant(input.egress, secret);
      const context = await browser.newContext({
        acceptDownloads: true,
        serviceWorkers: "block",
        proxy: { server: proxyServer, username: "bugpaw", password: proxyGrant },
      });
      for (const grant of input.permissionGrants) {
        await context.grantPermissions(grant.permissions, { origin: grant.origin });
      }
      await context.routeWebSocket(/.*/u, (socket) => socket.close());
      return new BrowserSession(context, { maxPages: input.maxPages, trustedOrigins: input.egress.trustedOrigins });
    },
  });
  server.listen(Number(process.env.PORT ?? "7081"), "0.0.0.0");
  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await browser.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}

/** 以禁止旁路网络的固定参数启动 Chromium。 */
function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [
      "--disable-quic",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--webrtc-ip-handling-policy=disable_non_proxied_udp",
    ],
  });
}

void start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "浏览器 Worker 启动失败");
  process.exit(1);
});
