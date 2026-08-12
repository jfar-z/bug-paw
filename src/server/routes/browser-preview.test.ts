import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { BrowserAutomationError } from "../browser-automation/browser-error";
import { registerBrowserPreviewRoutes } from "./browser-preview";

/** 内部预览只凭不透明授权读取资源，失败统一隐藏为 404。 */
describe("浏览器预览路由", () => {
  it("返回严格安全响应头与文件内容", async () => {
    const app = Fastify();
    registerBrowserPreviewRoutes(app, { read: vi.fn(async () => ({ content: Buffer.from("<!doctype html>"), mediaType: "text/html" })) });
    const response = await app.inject({ method: "GET", url: "/internal/browser-preview/token-a/index.html" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    await app.close();
  });

  it("授权过期和越界都返回 404", async () => {
    const app = Fastify();
    registerBrowserPreviewRoutes(app, { read: vi.fn(async () => { throw new BrowserAutomationError("BROWSER_CONTEXT_EXPIRED", "expired", false); }) });
    expect((await app.inject({ method: "GET", url: "/internal/browser-preview/bad/index.html" })).statusCode).toBe(404);
    await app.close();
  });
});
