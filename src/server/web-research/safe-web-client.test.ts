import { describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { createPinnedLookup, SafeWebClient, WebResearchSecurityError } from "./safe-web-client";
import type { WebResearchEgressProfile } from "../../shared/web-research-egress-contracts";

describe("安全网页客户端", () => {
  const policy = DEFAULT_WEB_RESEARCH_CONFIG;

  it.each(["file:///etc/passwd", "ftp://example.com", "http://127.0.0.1", "http://169.254.169.254/latest/meta-data"])("拒绝危险目标 %s", async (url) => {
    const client = new SafeWebClient({ resolve: async () => ["93.184.216.34"], request: vi.fn() });

    await expect(client.fetchText(url, { ...policy, httpsOnly: false })).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
  });

  it("重定向到私网地址时再次拦截", async () => {
    const client = new SafeWebClient({
      resolve: async (hostname) => hostname === "public.example" ? ["93.184.216.34"] : ["10.0.0.1"],
      request: vi.fn(async () => ({ statusCode: 302, headers: { location: "https://private.example/admin" }, body: "" })),
    });

    await expect(client.fetchText("https://public.example/start", policy)).rejects.toMatchObject({ code: "WEB_URL_BLOCKED" });
  });

  it("仅在选中匹配的 Fake-IP 出口时允许合成地址", async () => {
    const fakeIp: WebResearchEgressProfile = { id: "trusted-fake-ip", label: "受信任 Fake-IP DNS", kind: "fake-ip", fakeIpCidrs: ["198.18.0.0/15"] };
    const client = new SafeWebClient({
      resolve: async () => ["198.18.0.8"],
      request: vi.fn(async () => ({ statusCode: 200, headers: { "content-type": "text/html" }, body: "公开正文" })),
    });

    await expect(client.fetchText("https://public.example/article", policy, fakeIp)).resolves.toMatchObject({ finalUrl: "https://public.example/article" });
  });

  it("拒绝超出响应体上限的正文", async () => {
    const client = new SafeWebClient({
      resolve: async () => ["93.184.216.34"],
      request: vi.fn(async () => ({ statusCode: 200, headers: { "content-type": "text/html", "content-length": "2097153" }, body: "过大" })),
    });

    await expect(client.fetchText("https://public.example/article", policy)).rejects.toMatchObject({ code: "WEB_RESPONSE_TOO_LARGE" });
  });

  it("只返回受限文本响应", async () => {
    const client = new SafeWebClient({
      resolve: async () => ["93.184.216.34"],
      request: vi.fn(async () => ({ statusCode: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: "<main>公开正文</main>" })),
    });

    await expect(client.fetchText("https://public.example/article", policy)).resolves.toEqual({
      finalUrl: "https://public.example/article",
      contentType: "text/html",
      body: "<main>公开正文</main>",
    });
  });

  it("对外只暴露稳定安全错误", () => {
    expect(new WebResearchSecurityError("WEB_FETCH_TIMEOUT", "内部细节")).toMatchObject({ code: "WEB_FETCH_TIMEOUT", message: "联网页面请求超时，请稍后重试" });
  });

  it("Node 请求多地址模式下返回已校验地址数组", async () => {
    const lookup = createPinnedLookup("198.18.0.8");

    await new Promise<void>((resolve, reject) => {
      lookup("huggingface.co", { all: true }, (error, addresses) => {
        if (error) return reject(error);
        expect(addresses).toEqual([{ address: "198.18.0.8", family: 4 }]);
        resolve();
      });
    });
  });
});
