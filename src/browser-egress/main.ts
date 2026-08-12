import { readFile } from "node:fs/promises";

import { createBrowserEgressProxy } from "./proxy-server";

/** 启动只监听容器内部网络的浏览器出口代理。 */
async function start(): Promise<void> {
  const secretPath = process.env.BUG_PAW_BROWSER_TOKEN_FILE;
  if (!secretPath) throw new Error("缺少浏览器内部通信密钥文件路径");
  const secret = (await readFile(secretPath, "utf8")).trim();
  if (!secret) throw new Error("浏览器内部通信密钥为空");
  const port = Number(process.env.PORT ?? "7082");
  const server = createBrowserEgressProxy({ secret });
  server.listen(port, "0.0.0.0");
  const close = () => server.close(() => process.exit(0));
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "浏览器出口代理启动失败");
  process.exit(1);
});
