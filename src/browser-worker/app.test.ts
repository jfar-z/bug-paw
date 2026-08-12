import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserWorkerClient } from "../server/browser-automation/browser-worker-client";
import { createBrowserWorkerApp, type WorkerBrowserSession } from "./app";

/** Worker 内部 API 只接受签名请求并管理隔离 Context。 */
describe("浏览器 Worker API", () => {
  const closeCallbacks: Array<() => Promise<void>> = [];

  afterEach(async () => Promise.all(closeCallbacks.splice(0).map((close) => close())));

  it("拒绝未认证请求", async () => {
    const { baseUrl } = await startWorker();

    const response = await fetch(`${baseUrl}/v1/contexts`, { method: "POST", body: "{}" });

    expect(response.status).toBe(401);
  });

  it("创建、执行并幂等关闭 Context", async () => {
    const session: WorkerBrowserSession = {
      execute: vi.fn(async () => ({ title: "Example" })),
      close: vi.fn(async () => undefined),
    };
    const { baseUrl } = await startWorker(async () => session);
    const client = workerClient(baseUrl, () => crypto.randomUUID());
    const input = contextInput();

    await expect(client.createContext(input)).resolves.toEqual({ contextId: "lease-a" });
    await expect(client.execute("lease-a", { type: "snapshot", maxCharacters: 1_000 })).resolves.toEqual({ title: "Example" });
    await client.closeContext("lease-a");
    await client.closeContext("lease-a");
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("拒绝重复 nonce 和不存在的 Context", async () => {
    const { baseUrl } = await startWorker();
    const replaying = workerClient(baseUrl, () => "same-nonce");
    await replaying.createContext(contextInput());

    await expect(replaying.createContext({ ...contextInput(), leaseId: "lease-b" })).rejects.toMatchObject({
      code: "BROWSER_WORKER_PROTOCOL_INVALID",
    });
    const fresh = workerClient(baseUrl, () => crypto.randomUUID());
    await expect(fresh.execute("missing", { type: "snapshot", maxCharacters: 1_000 })).rejects.toMatchObject({
      code: "BROWSER_CONTEXT_NOT_OPEN",
    });
  });

  it("拒绝未知原子命令而不传给 Session", async () => {
    const session: WorkerBrowserSession = {
      execute: vi.fn(async () => ({})),
      close: vi.fn(async () => undefined),
    };
    const { baseUrl } = await startWorker(async () => session);
    const client = workerClient(baseUrl, () => crypto.randomUUID());
    await client.createContext(contextInput());

    await expect(client.execute("lease-a", { type: "evaluate", script: "1 + 1" } as never)).rejects.toMatchObject({
      code: "BROWSER_WORKER_PROTOCOL_INVALID",
    });
    expect(session.execute).not.toHaveBeenCalled();
  });

  it("二进制产物通过一次性端点传输且不会进入 JSON", async () => {
    const session: WorkerBrowserSession = {
      execute: vi.fn(async () => ({ artifact: { content: Buffer.from("image-bytes"), mediaType: "image/png", suggestedName: "capture.png" } })),
      close: vi.fn(async () => undefined),
    };
    const { baseUrl } = await startWorker(async () => session);
    const client = workerClient(baseUrl, () => crypto.randomUUID());
    await client.createContext(contextInput());

    const result = await client.execute<{ artifact: { handle: string; mediaType: string; size: number; suggestedName?: string } }>(
      "lease-a",
      { type: "screenshot", mode: "viewport", format: "png" },
    );

    expect(result.artifact).toMatchObject({ mediaType: "image/png", size: 11, suggestedName: "capture.png" });
    expect(result.artifact).not.toHaveProperty("content");
    await expect(client.readArtifact("lease-a", result.artifact.handle, 100)).resolves.toEqual(Buffer.from("image-bytes"));
    await expect(client.readArtifact("lease-a", result.artifact.handle, 100)).rejects.toMatchObject({
      code: "BROWSER_WORKER_PROTOCOL_INVALID",
    });
  });

  it("上传内容复制到 Worker 私有临时文件并随 Context 清理", async () => {
    let receivedHandle = "";
    const session: WorkerBrowserSession = {
      execute: vi.fn(async (command) => {
        if (command.type === "upload") receivedHandle = command.files[0]!.handle;
        return {};
      }),
      close: vi.fn(async () => undefined),
    };
    const { baseUrl } = await startWorker(async () => session);
    const client = workerClient(baseUrl, () => crypto.randomUUID());
    await client.createContext(contextInput());
    const upload = await client.uploadFile("lease-a", "fixture.txt", "text/plain", Buffer.from("upload-content"), 100);
    await client.execute("lease-a", { type: "upload", ref: "g1-e1", files: [upload] });
    expect(upload).toMatchObject({ name: "fixture.txt", mediaType: "text/plain" });
    expect(receivedHandle).not.toContain("fixture.txt");
    expect(receivedHandle).not.toBe(upload.handle);
  });

  async function startWorker(createSession: () => Promise<WorkerBrowserSession> = async () => ({ execute: async () => ({}), close: async () => undefined })) {
    const server = createBrowserWorkerApp({ secret: "test-secret", createSession, now: () => 1_700_000_000_000 });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    closeCallbacks.push(async () => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address() as AddressInfo;
    return { baseUrl: `http://127.0.0.1:${address.port}` };
  }
});

/** 创建指向测试 Worker 的签名 client。 */
function workerClient(baseUrl: string, nonce: () => string): BrowserWorkerClient {
  return new BrowserWorkerClient({ baseUrl, secret: "test-secret", now: () => 1_700_000_000_000, nonce });
}

/** 创建最小 Context 请求。 */
function contextInput(): import("../shared/browser-worker-protocol").CreateBrowserContextRequest {
  return {
    leaseId: "lease-a",
    egress: { leaseId: "lease-a", expiresAt: 1_700_000_060_000, trustedOrigins: [] },
    permissionGrants: [],
    maxPages: 2,
  };
}
