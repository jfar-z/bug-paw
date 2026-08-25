// @vitest-environment node

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { AvatarCropArea } from "../../shared/avatar-contracts";
import { AgentStore } from "../agents/agent-store";
import { AgentPromptStore } from "../agents/agent-prompt-store";
import { createDataPaths } from "../paths";
import type { AuthService } from "./auth";
import { registerAgentRoutes } from "./agents";

describe("Agent 配置路由", () => {
  const roots: string[] = [];

  async function fixture(authenticated = true) {
    const root = await mkdtemp(join(tmpdir(), "pi-agent-routes-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const commitSessions = vi.fn(async () => undefined);
    const rollbackSessions = vi.fn(async () => undefined);
    const stageSessions = vi.fn(async () => ({ commit: commitSessions, rollback: rollbackSessions }));
    const store = new AgentStore(paths, { stageSessions });
    await store.createDefault();
    const authService: AuthService = {
      login: vi.fn(async () => ({ status: "invalid" as const })),
      logout: vi.fn(async () => undefined),
      isAuthenticated: vi.fn(async () => authenticated),
      isInitialized: vi.fn(async () => true),
      getProfile: vi.fn(async () => undefined),
      updateProfile: vi.fn(async () => { throw new Error("测试未使用个人资料更新"); }),
    };
    const refreshAgent = vi.fn(async () => undefined);
    const removeAgent = vi.fn(async () => undefined);
    const restoreAgent = vi.fn(() => undefined);
    const countSessions = vi.fn(async () => 2);
    const app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
    const prompts = new AgentPromptStore(paths.agentsDir);
    const dependencies = { authService, store, prompts, refreshAgent, removeAgent, restoreAgent, countSessions };
    registerAgentRoutes(app, dependencies);
    return { app, paths, store, prompts, stageSessions, commitSessions, refreshAgent, removeAgent, restoreAgent, countSessions };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

it("允许重名创建但生成唯一 ID 和 cwd", async () => {
    const { app } = await fixture();
    const first = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "研究助手" } });
    const second = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "研究助手" } });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().profile.id).not.toBe(second.json().profile.id);
    expect(first.json().profile.cwd).not.toBe(second.json().profile.cwd);
    await app.close();
  });

it("读取和修改 Agent 的独立提示词文件", async () => {
    const { app, store, prompts } = await fixture();
    const created = await store.create({ name: "提示词 Agent" });
    const files = ["role", "behavior", "rules", "user", "bootsharp"] as const;

    for (const file of files) {
      const existing = await prompts.read(created.profile.id, file);
      const initial = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/prompts/${file}` });
      expect(initial.statusCode).toBe(200);
      expect(initial.json()).toEqual({ file, content: existing });

      const content = `${file} 的测试内容`;
      const saved = await app.inject({
        method: "PUT",
        url: `/api/agents/${created.profile.id}/prompts/${file}`,
        payload: { content },
      });
      expect(saved.statusCode).toBe(200);
      expect(await prompts.read(created.profile.id, file)).toBe(content);
    }
    await app.close();
  });

it("更新 Agent 配置后只落盘，等待用户手动刷新 Pi 配置", async () => {
    const { app, store, refreshAgent } = await fixture();
    const created = await store.create({ name: "A" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.profile.id}`,
      payload: { revision: created.revision, name: "已保存" },
    });

    expect(response.statusCode).toBe(200);
    expect(refreshAgent).not.toHaveBeenCalled();
    await app.close();
  });

it("归档后返回冲突，恢复后重新可用", async () => {
    const { app, store } = await fixture();
    const created = await store.create({ name: "A" });
    const archived = await app.inject({ method: "POST", url: `/api/agents/${created.profile.id}/archive`, payload: { revision: created.revision } });
    expect(archived.statusCode).toBe(200);
    await expect(store.assertCanCreateSession(created.profile.id)).rejects.toThrow("归档");
    const restored = await app.inject({ method: "DELETE", url: `/api/agents/${created.profile.id}/archive`, payload: { revision: archived.json().revision } });
    expect(restored.statusCode).toBe(200);
    await expect(store.assertCanCreateSession(created.profile.id)).resolves.toBeUndefined();
    await app.close();
  });

});

function avatarMultipart(boundary: string, content: Buffer, crop: AvatarCropArea): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`, "utf8"),
    content,
    Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="crop"\r\n\r\n`
      + `${JSON.stringify(crop)}\r\n--${boundary}--\r\n`,
      "utf8",
    ),
  ]);
}
