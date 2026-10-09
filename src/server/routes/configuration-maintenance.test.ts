// @vitest-environment node
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentStore } from "../agents/agent-store";
import { createDataPaths } from "../paths";
import { createVersionedJsonStore } from "../configuration/versioned-json-store";
import { ConfigHistory } from "../configuration/config-history";
import { registerConfigurationRoutes } from "./configuration";
import type { AuthService } from "./auth";

/** 所有写入限定于临时测试目录，不接触生产快照或配置。 */
async function fixture(authenticated = true, failRefresh = false) {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-maintenance-"));
  const paths = await createDataPaths(root);
  const agents = new AgentStore(paths); await agents.createDefault();
  const app = Fastify();
  registerConfigurationRoutes(app, { paths, agents, authService: { isAuthenticated: async () => authenticated } as unknown as AuthService,
    overviewReaders: { providers: async () => ({ summary: "0 个 Provider", needsConfiguration: true }), tts: async () => { throw new Error("语音配置读取 HTTP 503"); } },
    refreshRuntime: async () => { if (failRefresh) throw new Error("刷新模型目录 HTTP 503"); return { abortedSessions: 0 }; },
  });
  return { app, paths, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("配置维护合同", () => {
  it("摘要和恢复预览均要求登录，单项读取失败不会变成零", async () => {
    const denied = await fixture(false);
    try { for (const url of ["/api/configuration/overview", "/api/configuration/history/demo/preview"]) expect((await denied.app.inject({ url })).statusCode).toBe(401); } finally { await denied.close(); }
    const f = await fixture();
    try {
      const res = await f.app.inject({ url: "/api/configuration/overview" });
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().entries).toEqual([expect.objectContaining({ key: "providers", needsConfiguration: true }), expect.objectContaining({ key: "tts", error: { message: "语音配置读取 HTTP 503", requestId: expect.any(String) } })]);
      expect(res.json().entries[1]).not.toHaveProperty("summary");
    } finally { await f.close(); }
  });
  it("恢复差异脱敏且绑定读取时版本，期间修改导致冲突而不是被覆盖", async () => {
    const f = await fixture();
    try {
      const store = createVersionedJsonStore<Record<string, unknown>>(join(f.paths.piDir, "settings.json"));
      await store.write({ defaultThinkingLevel: "medium", custom: "PRIVATE_UNKNOWN_VALUE", password: "PRIVATE_CREDENTIAL" });
      const history = new ConfigHistory(f.paths.historyDir);
      await history.recordSnapshot({ id: "demo", scope: "global", revision: "old", value: { defaultThinkingLevel: "high", custom: "OLD_UNKNOWN_VALUE" } });
      const result = await f.app.inject({ url: "/api/configuration/history/demo/preview" });
      expect(result.statusCode).toBe(200);
      expect(result.body).not.toContain("PRIVATE_UNKNOWN_VALUE"); expect(result.body).not.toContain("PRIVATE_CREDENTIAL"); expect(result.body).not.toContain("OLD_UNKNOWN_VALUE");
      expect(result.json().differences).toContainEqual({ field: "defaultThinkingLevel", current: '"medium"', restored: '"high"' });
      await store.write({ defaultThinkingLevel: "low" }, result.json().revision);
      const restore = await f.app.inject({ method: "POST", url: "/api/configuration/history/demo/restore", payload: { revision: result.json().revision } });
      expect(restore.statusCode).toBe(409); expect(restore.json().error.code).toBe("VERSION_CONFLICT");
      expect((await store.read()).value?.defaultThinkingLevel).toBe("low");
    } finally { await f.close(); }
  });
  it("导入后刷新失败保留提交事实及具体错误，旧预览不可重放", async () => {
    const f = await fixture(true, true);
    try {
      const preview = await f.app.inject({ method: "POST", url: "/api/configuration/import/preview", payload: { version: 1, files: { settings: { value: { defaultThinkingLevel: "high" } } } } });
      expect(preview.json().invalid).toEqual([]);
      const payload = { previewId: preview.json().previewId, confirmed: true };
      const result = await f.app.inject({ method: "POST", url: "/api/configuration/import/apply", payload });
      expect(result.json()).toMatchObject({ applied: true, runtimeRefreshRequired: true, postCommitError: { message: expect.stringContaining("HTTP 503"), requestId: expect.any(String) } });
      const repeated = await f.app.inject({ method: "POST", url: "/api/configuration/import/apply", payload });
      expect(repeated.json().error.code).toBe("IMPORT_PREVIEW_EXPIRED");
      expect((await createVersionedJsonStore<Record<string, unknown>>(join(f.paths.piDir, "settings.json")).read()).value?.defaultThinkingLevel).toBe("high");
    } finally { await f.close(); }
  });
});
