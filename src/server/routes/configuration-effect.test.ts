// @vitest-environment node
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentStore } from "../agents/agent-store";
import { createDataPaths } from "../paths";
import type { AuthService } from "./auth";
import { registerConfigurationRoutes } from "./configuration";

/** 用临时数据目录验证落盘成功与运行时应用是独立结果。 */
async function fixture(refreshAgent: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-config-effect-"));
  const paths = await createDataPaths(root);
  const agents = new AgentStore(paths);
  await agents.createDefault();
  const agent = (await agents.list())[0];
  const app = Fastify();
  registerConfigurationRoutes(app, { paths, agents, authService: { isAuthenticated: async () => true } as unknown as AuthService, refreshAgent });
  return { app, agentId: agent.profile.id, close: async () => { await app.close(); await rm(root, { recursive: true, force: true }); } };
}

describe("运行设置生效结果", () => {
  it("全局保存需要手动刷新，Agent 自动刷新成功才报告已应用", async () => {
    const refresh = vi.fn(async () => undefined);
    const f = await fixture(refresh);
    try {
      const global = await f.app.inject({ method: "GET", url: "/api/configuration/global" });
      const globalSave = await f.app.inject({ method: "PATCH", url: "/api/configuration/global", payload: { revision: global.json().revision, set: { defaultThinkingLevel: "high" }, inherit: [] } });
      expect(globalSave.statusCode).toBe(200);
      expect(globalSave.json().runtimeRefreshRequired).toBe(true);
      expect(refresh).not.toHaveBeenCalled();
      const local = await f.app.inject({ method: "GET", url: `/api/agents/${f.agentId}/settings` });
      const localSave = await f.app.inject({ method: "PATCH", url: `/api/agents/${f.agentId}/settings`, payload: { revision: local.json().revision, set: { defaultThinkingLevel: "low" }, inherit: [] } });
      expect(localSave.statusCode).toBe(200);
      expect(localSave.json().runtimeRefreshRequired).toBe(false);
      expect(refresh).toHaveBeenCalledWith(f.agentId);
    } finally { await f.close(); }
  });

  it("Agent 刷新失败仍保留已提交 revision，提示手动刷新而不伪装已应用", async () => {
    const f = await fixture(async () => { throw new Error("模拟 Agent 刷新中断"); });
    try {
      const url = `/api/agents/${f.agentId}/settings`;
      const initial = await f.app.inject({ method: "GET", url });
      const saved = await f.app.inject({ method: "PATCH", url, payload: { revision: initial.json().revision, set: { defaultThinkingLevel: "high" }, inherit: [] } });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().runtimeRefreshRequired).toBe(true);
      const disk = await f.app.inject({ method: "GET", url });
      expect(disk.json().revision).toBe(saved.json().revision);
      expect(disk.json().own.defaultThinkingLevel).toBe("high");
    } finally { await f.close(); }
  });
});
