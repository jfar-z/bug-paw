import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NoopBrowserAuthStateProvider } from "./browser-auth-state-provider";

/** 第一期认证状态接口必须保持无持久化。 */
describe("空浏览器认证状态 Provider", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("读取为空、清理幂等且保存明确拒绝", async () => {
    const root = await mkdtemp(join(tmpdir(), "browser-auth-state-"));
    roots.push(root);
    const provider = new NoopBrowserAuthStateProvider();
    const scope = { userId: "user-a", agentId: "agent-a", origin: "https://example.com" };

    await expect(provider.load(scope)).resolves.toBeUndefined();
    await expect(provider.clear(scope)).resolves.toBeUndefined();
    await expect(provider.save(scope, { cookies: [] })).rejects.toMatchObject({
      code: "BROWSER_AUTH_STATE_DISABLED",
      message: "第一期未启用浏览器登录态保存",
    });
    expect(await readdir(root)).toEqual([]);
  });
});
