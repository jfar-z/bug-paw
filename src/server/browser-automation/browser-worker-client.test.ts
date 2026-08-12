import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { BrowserAutomationError } from "./browser-error";
import { BrowserWorkerClient } from "./browser-worker-client";

/** 主服务到 Worker 的内部请求必须具备认证、上限和取消语义。 */
describe("浏览器 Worker client", () => {
  it("按固定规范签名创建 Context 请求", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const body = String(init?.body ?? "");
      const timestamp = headers.get("x-bugpaw-timestamp")!;
      const nonce = headers.get("x-bugpaw-nonce")!;
      const contentHash = createHash("sha256").update(body).digest("hex");
      const canonical = `POST\n/v1/contexts\n${timestamp}\n${nonce}\n${contentHash}`;
      expect(headers.get("x-bugpaw-content-sha256")).toBe(contentHash);
      expect(headers.get("x-bugpaw-signature")).toBe(createHmac("sha256", "test-secret").update(canonical).digest("hex"));
      return Response.json({ status: "ok", data: { contextId: "context-a" } });
    });
    const client = new BrowserWorkerClient({
      baseUrl: "http://worker.internal",
      secret: "test-secret",
      fetch: fetchMock,
      now: () => 1_700_000_000_000,
      nonce: () => "nonce-a",
    });

    await expect(client.createContext({
      leaseId: "lease-a",
      egress: { leaseId: "lease-a", expiresAt: 1_700_000_060_000, trustedOrigins: [] },
      permissionGrants: [],
      maxPages: 2,
    })).resolves.toEqual({ contextId: "context-a" });
  });

  it("把无效协议和超大响应映射为稳定故障", async () => {
    const invalid = clientWith(async () => Response.json({ unexpected: true }));
    const oversized = clientWith(async () => new Response("x".repeat(2 * 1024 * 1024 + 1), {
      headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024 + 1) },
    }));

    await expect(invalid.health()).rejects.toMatchObject({ code: "BROWSER_WORKER_PROTOCOL_INVALID" });
    await expect(oversized.health()).rejects.toMatchObject({ code: "BROWSER_WORKER_PROTOCOL_INVALID" });
  });

  it("保留 AbortSignal 的取消原因", async () => {
    const controller = new AbortController();
    const client = clientWith(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      controller.abort(new DOMException("用户取消", "AbortError"));
    }));

    await expect(client.health(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("将连接故障映射为可重试的 Worker 错误", async () => {
    const client = clientWith(async () => { throw new TypeError("connect ECONNREFUSED 10.0.0.9"); });

    await expect(client.health()).rejects.toEqual(expect.objectContaining<Partial<BrowserAutomationError>>({
      code: "BROWSER_WORKER_UNAVAILABLE",
      message: "浏览器执行服务暂时不可用",
      retryable: true,
    }));
  });
});

/** 创建使用固定内部参数的测试 client。 */
function clientWith(fetch: typeof globalThis.fetch): BrowserWorkerClient {
  return new BrowserWorkerClient({
    baseUrl: "http://worker.internal",
    secret: "test-secret",
    fetch,
    now: () => 1_700_000_000_000,
    nonce: () => "nonce-a",
  });
}
