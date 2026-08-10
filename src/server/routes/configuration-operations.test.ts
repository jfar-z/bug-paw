// @vitest-environment node

import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentStore } from "../agents/agent-store";
import { createDataPaths } from "../paths";
import type { AuthService } from "./auth";
import { registerConfigurationRoutes } from "./configuration";

describe("配置运维路由", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "pi-configuration-operations-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const agents = new AgentStore(paths);
    await agents.createDefault();
    await writeFile(join(paths.piDir, "models.json"), JSON.stringify({ providers: { local: { baseUrl: "http://localhost:11434", headers: { Authorization: "Bearer header-secret" } } } }), "utf8");
    await writeFile(join(paths.piDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 2 } }), "utf8");
    await writeFile(join(paths.piDir, "auth.json"), JSON.stringify({ cloud: { type: "api_key", key: "auth-secret" } }), "utf8");
    const app = Fastify();
    await app.register(cookie);
    const authService = { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService;
    registerConfigurationRoutes(app, { authService, paths, agents });
    return { app, paths };
  }

  it("安全导出排除凭证、密码和 Header 值", async () => {
    const { app, paths } = await fixture();
    const response = await app.inject({ method: "GET", url: "/api/configuration/export" });
    const body = response.body;
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(body).not.toContain("auth-secret");
    expect(body).not.toContain("header-secret");
    expect(JSON.parse(body)).toMatchObject({ version: 1, files: { models: expect.any(Object), settings: expect.any(Object) } });
    const preview = await app.inject({ method: "POST", url: "/api/configuration/import/preview", payload: JSON.parse(body) });
    const applied = await app.inject({ method: "POST", url: "/api/configuration/import/apply", payload: { previewId: preview.json().previewId, confirmed: true } });
    expect(applied.statusCode).toBe(200);
    expect(await readFile(join(paths.piDir, "models.json"), "utf8")).toContain("header-secret");
    await app.close();
  });

  it("标准 Pi JSON 只预览不落盘，外部变更后应用返回版本冲突", async () => {
    const { app, paths } = await fixture();
    const modelsPath = join(paths.piDir, "models.json");
    const before = await readFile(modelsPath, "utf8");
    const preview = await app.inject({
      method: "POST",
      url: "/api/configuration/import/preview",
      payload: { providers: { imported: { baseUrl: "http://localhost:11434" } } },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ previewId: expect.any(String), changed: expect.any(Array), conflicts: [], invalid: [] });
    expect(await readFile(modelsPath, "utf8")).toBe(before);

    await writeFile(modelsPath, JSON.stringify({ providers: { external: { baseUrl: "http://localhost:11434" } } }), "utf8");
    const applied = await app.inject({
      method: "POST",
      url: "/api/configuration/import/apply",
      payload: { previewId: preview.json().previewId, confirmed: true },
    });
    expect(applied.statusCode).toBe(409);
    expect(applied.json()).toMatchObject({ error: { code: "VERSION_CONFLICT" } });
    await app.close();
  });

  it("设置历史只公开摘要并按当前 revision 重新校验恢复", async () => {
    const { app } = await fixture();
    const current = await app.inject({ method: "GET", url: "/api/configuration/global" });
    const updated = await app.inject({
      method: "PATCH",
      url: "/api/configuration/global",
      payload: { revision: current.json().revision, set: { retry: { maxRetries: 5 } }, inherit: [] },
    });
    expect(updated.statusCode).toBe(200);

    const history = await app.inject({ method: "GET", url: "/api/configuration/history" });
    expect(history.statusCode).toBe(200);
    expect(history.body).not.toContain("maxRetries");
    const entry = history.json().entries[0];
    expect(entry).toMatchObject({ summary: "更新全局 Pi 设置", restorable: true });

    const restored = await app.inject({
      method: "POST",
      url: `/api/configuration/history/${entry.id}/restore`,
      payload: { revision: updated.json().revision },
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().own.retry.maxRetries).toBe(2);
    await app.close();
  });
});
