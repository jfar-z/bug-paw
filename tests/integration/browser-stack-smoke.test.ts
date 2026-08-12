// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { BrowserWorkerClient } from "../../src/server/browser-automation/browser-worker-client";

const enabled = process.env.RUN_BROWSER_STACK_E2E === "true";

/** 对真实 Worker、Chromium 和出口代理执行最小端到端验收。 */
describe.skipIf(!enabled)("浏览器容器栈", () => {
  it("创建 Context、访问公网 HTTPS、快照、截图并幂等关闭", async () => {
    const secret = (await readFile(required("BROWSER_E2E_TOKEN_FILE"), "utf8")).trim();
    const client = new BrowserWorkerClient({ baseUrl: required("BROWSER_E2E_WORKER_URL"), secret });
    const leaseId = crypto.randomUUID();
    await client.createContext({
      leaseId,
      egress: { leaseId, expiresAt: Date.now() + 120_000, trustedOrigins: [] },
      permissionGrants: [],
      maxPages: 2,
    });
    try {
      await expect(client.execute(leaseId, { type: "open", target: { kind: "url", url: "http://example.com" }, newPage: false }))
        .rejects.toBeDefined();
      const opened = await client.execute<{ url: string }>(leaseId, { type: "open", target: { kind: "url", url: "https://example.com" }, newPage: false });
      expect(opened.url).toMatch(/^https:\/\/example\.com\/?$/u);
      const snapshot = await client.execute<{ text: string }>(leaseId, { type: "snapshot", maxCharacters: 10_000 });
      expect(snapshot.text).toContain("Example Domain");
      const screenshot = await client.execute<{ artifact: { handle: string; size: number } }>(leaseId, { type: "screenshot", mode: "viewport", format: "png" });
      expect((await client.readArtifact(leaseId, screenshot.artifact.handle, 5 * 1024 * 1024)).byteLength).toBeGreaterThan(100);
    } finally {
      await client.closeContext(leaseId);
      await client.closeContext(leaseId);
    }
  }, 60_000);
});

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
}
