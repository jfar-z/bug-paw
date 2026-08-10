// @vitest-environment node

import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const refreshPromptContext = vi.fn(async () => undefined);
    const removeAgent = vi.fn(async () => undefined);
    const restoreAgent = vi.fn(() => undefined);
    const countSessions = vi.fn(async () => 2);
    const app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
    const prompts = new AgentPromptStore(paths.agentsDir);
    const dependencies = { authService, store, prompts, refreshPromptContext, refreshAgent, removeAgent, restoreAgent, countSessions };
    registerAgentRoutes(app, dependencies);
    return { app, paths, store, prompts, stageSessions, commitSessions, refreshAgent, refreshPromptContext, removeAgent, restoreAgent, countSessions };
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("拒绝未登录读取", async () => {
    const { app } = await fixture(false);
    const response = await app.inject({ method: "GET", url: "/api/agents" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("AUTH_REQUIRED");
    await app.close();
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

  it("保存 Agent 排序并按该顺序返回列表", async () => {
    const { app, store } = await fixture();
    const first = await store.create({ name: "First" });
    const second = await store.create({ name: "Second" });

    const reordered = await app.inject({
      method: "POST",
      url: "/api/agents/order",
      payload: { agentIds: [second.profile.id, "default", first.profile.id] },
    });

    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().agents.map((item: { profile: { id: string } }) => item.profile.id)).toEqual([
      second.profile.id,
      "default",
      first.profile.id,
    ]);
    const listed = await app.inject({ method: "GET", url: "/api/agents" });
    expect(listed.json().agents.map((item: { profile: { id: string } }) => item.profile.id)).toEqual([
      second.profile.id,
      "default",
      first.profile.id,
    ]);
    await app.close();
  });

  it("创建 Agent 时采用请求中的自定义工作目录", async () => {
    const { app, paths } = await fixture();
    const cwd = join(paths.workspaceDir, "projects", "created");

    const response = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { name: "项目助手", cwd },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().profile.cwd).toBe(cwd);
    await app.close();
  });

  it("读取和修改 Agent 的独立提示词文件，并刷新当前会话", async () => {
    const { app, store, prompts, refreshPromptContext } = await fixture();
    const created = await store.create({ name: "提示词 Agent" });

    const initial = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/prompts/role` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ file: "role", content: "" });

    const saved = await app.inject({
      method: "PUT",
      url: `/api/agents/${created.profile.id}/prompts/role`,
      payload: { content: "负责测试" },
    });
    expect(saved.statusCode).toBe(200);
    expect(await prompts.read(created.profile.id, "role")).toBe("负责测试");
    expect(refreshPromptContext).toHaveBeenCalledWith(created.profile.id);
    await app.close();
  });

  it("拒绝未知提示词文件与非字符串内容", async () => {
    const { app, store } = await fixture();
    const created = await store.create({ name: "提示词 Agent" });

    const invalidFile = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/prompts/unknown` });
    const invalidContent = await app.inject({
      method: "PUT",
      url: `/api/agents/${created.profile.id}/prompts/role`,
      payload: { content: 123 },
    });
    expect(invalidFile.statusCode).toBe(400);
    expect(invalidContent.statusCode).toBe(400);
    await app.close();
  });

  it("拒绝把 Agent 工作目录更新到数据目录之外", async () => {
    const { app, store, refreshAgent } = await fixture();
    const created = await store.create({ name: "A" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.profile.id}`,
      payload: { revision: created.revision, name: "B", cwd: "/tmp/escape" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("WORKSPACE_OUTSIDE_DATA");
    expect(refreshAgent).not.toHaveBeenCalled();
    await app.close();
  });

  it("拒绝经 Profile 接口写入提示词，避免绕过 Markdown 与会话刷新", async () => {
    const { app, store } = await fixture();
    const created = await store.create({ name: "A" });

    const creating = await app.inject({ method: "POST", url: "/api/agents", payload: {
      name: "B", instructions: { role: "不应接受" },
    } });
    const updating = await app.inject({ method: "PATCH", url: `/api/agents/${created.profile.id}`, payload: {
      revision: created.revision, instructions: { role: "不应接受" },
    } });

    expect(creating.json().error.code).toBe("PROMPT_FILES_ONLY");
    expect(updating.json().error.code).toBe("PROMPT_FILES_ONLY");
    await app.close();
  });

  it("目标已有 .pi 时返回工作目录冲突", async () => {
    const { app, paths, store, refreshAgent } = await fixture();
    const created = await store.create({ name: "A" });
    await mkdir(join(created.profile.cwd, ".pi"), { recursive: true });
    const target = join(paths.workspaceDir, "projects", "occupied");
    await mkdir(join(target, ".pi"), { recursive: true });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.profile.id}`,
      payload: { revision: created.revision, cwd: target },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "WORKSPACE_PI_CONFLICT",
      message: "目标工作目录已存在 .pi，无法迁移",
    });
    expect(refreshAgent).not.toHaveBeenCalled();
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

  it("保存 Agent 的语音模型、音色覆盖和播放选项", async () => {
    const { app, store } = await fixture();
    const created = await store.create({ name: "语音 Agent" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.profile.id}`,
      payload: { revision: created.revision, ttsProfileId: "voice-a", ttsVoice: "Cherry", ttsAutoPlay: true, ttsStreamPlayback: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().profile).toMatchObject({ ttsProfileId: "voice-a", ttsVoice: "Cherry", ttsAutoPlay: true, ttsStreamPlayback: true });
    const cleared = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.profile.id}`,
      payload: { revision: response.json().revision, ttsProfileId: null },
    });
    expect(cleared.json().profile).not.toHaveProperty("ttsVoice");
    await app.close();
  });

  it("未选择语音模型时不保存孤立的 Agent 音色覆盖", async () => {
    const { app, store } = await fixture();
    const created = await store.create({ name: "无语音 Agent" });
    const response = await app.inject({
      method: "PATCH",
      url: `/api/agents/${created.profile.id}`,
      payload: { revision: created.revision, ttsVoice: "Cherry" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().profile).not.toHaveProperty("ttsVoice");
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

  it("Runtime 排空失败时撤销删除墓碑", async () => {
    const { app, store, removeAgent, restoreAgent } = await fixture();
    const created = await store.create({ name: "A" });
    removeAgent.mockRejectedValueOnce(new Error("drain timeout"));

    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${created.profile.id}/archive`,
      payload: { revision: created.revision },
    });

    expect(response.statusCode).toBe(400);
    expect(restoreAgent).toHaveBeenCalledWith(created.profile.id);
    await expect(store.get(created.profile.id)).resolves.toBeDefined();
    await app.close();
  });

  it("删除预览不改数据，删除选项独立控制 Session 和 cwd", async () => {
    const { app, store, stageSessions, commitSessions, removeAgent } = await fixture();
    const created = await store.create({ name: "待删除" });
    await writeFile(join(created.profile.cwd, "note.txt"), "content", "utf8");
    const preview = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/delete-preview` });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ agentId: created.profile.id, sessions: { count: 2 }, workspace: { files: 1, bytes: 7 } });
    await expect(store.get(created.profile.id)).resolves.toBeDefined();

    const removed = await app.inject({ method: "DELETE", url: `/api/agents/${created.profile.id}`, payload: { removeSessions: true, removeWorkspace: false } });
    expect(removed.statusCode).toBe(200);
    expect(stageSessions).toHaveBeenCalledWith(created.profile.id);
    expect(commitSessions).toHaveBeenCalledOnce();
    expect(removeAgent).toHaveBeenCalledWith(created.profile.id);
    await expect(stat(created.profile.cwd)).resolves.toMatchObject({});
    await app.close();
  });

  it("历史默认 Agent 可像普通 Agent 一样删除", async () => {
    const { app, store, removeAgent } = await fixture();
    const defaultAgent = await store.get("default");
    expect(defaultAgent).toBeDefined();

    const response = await app.inject({
      method: "DELETE",
      url: "/api/agents/default",
      payload: { removeSessions: false, removeWorkspace: false },
    });

    expect(response.statusCode).toBe(200);
    expect(removeAgent).toHaveBeenCalledWith("default");
    await expect(store.get("default")).resolves.toBeUndefined();
    await app.close();
  });

  it("校验并持久化本地图片头像", async () => {
    const { app, store } = await fixture();
    const created = await store.create({ name: "图片助手" });
    const boundary = "avatar-test";
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("image")]);
    const response = await app.inject({
      method: "POST",
      url: `/api/agents/${created.profile.id}/avatar?revision=${created.revision}`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: avatarMultipart(boundary, png),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().profile.avatar).toMatchObject({ kind: "image", mediaType: "image/png" });
    const image = await app.inject({ method: "GET", url: `/api/agents/${created.profile.id}/avatar` });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload).toEqual(png);
    await app.close();
  });

  it("拒绝不可用模型并钳制不支持的思考等级", async () => {
    const { app, store } = await fixture();
    const unavailable = await app.inject({ method: "POST", url: "/api/agents", payload: { name: "A", defaultModel: { provider: "none", id: "missing" } } });
    expect(unavailable.statusCode).toBe(400);

    const created = await store.create({ name: "B" });
    await app.close();
    const root = await mkdtemp(join(tmpdir(), "pi-agent-model-route-"));
    roots.push(root);
    const paths = await createDataPaths(root);
    const validatingStore = new AgentStore(paths);
    const validatingApp = Fastify();
    await validatingApp.register(cookie);
    const authService = { login: vi.fn(), logout: vi.fn(), isAuthenticated: vi.fn(async () => true) } as unknown as AuthService;
    registerAgentRoutes(validatingApp, {
      authService,
      store: validatingStore,
      resolveAvailableModel: async (provider, id) => provider === "openai" && id === "plain" ? { reasoning: false } : undefined,
    });
    const target = await validatingStore.create({ name: created.profile.name });
    const clamped = await validatingApp.inject({ method: "PATCH", url: `/api/agents/${target.profile.id}`, payload: { revision: target.revision, defaultModel: { provider: "openai", id: "plain" }, defaultThinkingLevel: "high" } });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json().profile.defaultThinkingLevel).toBe("off");
    await validatingApp.close();
  });
});

function avatarMultipart(boundary: string, content: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="avatar"; filename="avatar.png"\r\nContent-Type: image/png\r\n\r\n`, "utf8"),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}
