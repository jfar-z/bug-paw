// @vitest-environment node

import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerApiV1Namespace } from "../http/api-versioning";
import { TtsConfigService } from "../tts/tts-config-service";
import { registerTtsRoutes } from "./tts";
import type { AuthService } from "./auth";

describe("语音合成配置路由", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("创建并读取脱敏语音配置", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-routes-"));
    roots.push(root);
    const app = Fastify();
    registerApiV1Namespace(app);
    registerTtsRoutes(app, {
      authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService,
      configs: new TtsConfigService(join(root, "tts.json")),
      synthesize: { synthesize: vi.fn() },
      isProfileInUse: vi.fn(async () => false),
      getAgentTtsProfile: vi.fn(async () => undefined),
    });
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/tts",
      payload: {
        name: "中文语音",
        baseUrl: "https://tts.example/v1",
        model: "tts-1",
        voice: "alloy",
        responseFormat: "mp3",
        apiKey: randomUUID(),
        customParameters: { response_format: "pcm", instructions: "用愉快语气朗读" },
      },
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/capabilities/tts" });

    expect(created.statusCode).toBe(201);
    expect(listed.headers["cache-control"]).toBe("no-store");
    expect(listed.json().profiles).toEqual([expect.objectContaining({
      name: "中文语音",
      hasApiKey: true,
      customParameters: { response_format: "pcm", instructions: "用愉快语气朗读" },
    })]);
    expect(listed.json().profiles[0]).not.toHaveProperty("apiKey");
    await app.close();
  });

  it("拒绝模型级自定义参数覆盖 input", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-routes-"));
    roots.push(root);
    const app = Fastify();
    registerApiV1Namespace(app);
    registerTtsRoutes(app, {
      authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService,
      configs: new TtsConfigService(join(root, "tts.json")),
      synthesize: { synthesize: vi.fn() },
      isProfileInUse: vi.fn(async () => false),
      getAgentTtsProfile: vi.fn(async () => undefined),
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/tts",
      payload: {
        name: "无效语音",
        baseUrl: "https://tts.example/v1",
        model: "tts-1",
        voice: "alloy",
        responseFormat: "mp3",
        apiKey: randomUUID(),
        customParameters: { input: "覆盖" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: "VALIDATION_FAILED",
      message: "TTS 自定义请求参数不能覆盖 input",
    });
    await app.close();
  });

  it("认证用户可按需读取指定 TTS 配置的 API Key", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-routes-"));
    roots.push(root);
    const app = Fastify();
    registerApiV1Namespace(app);
    registerTtsRoutes(app, {
      authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService,
      configs: new TtsConfigService(join(root, "tts.json")),
      synthesize: { synthesize: vi.fn() },
      isProfileInUse: vi.fn(async () => false),
      getAgentTtsProfile: vi.fn(async () => undefined),
    });
    await app.ready();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/capabilities/tts",
      payload: { name: "中文语音", baseUrl: "https://tts.example/v1", model: "tts-1", voice: "alloy", responseFormat: "mp3", apiKey: "tts-secret" },
    });
    const shown = await app.inject({ method: "GET", url: `/api/v1/capabilities/tts/${created.json().profile.id}/credential` });
    const listed = await app.inject({ method: "GET", url: "/api/v1/capabilities/tts" });

    expect(shown.statusCode).toBe(200);
    expect(shown.json()).toEqual({ apiKey: "tts-secret" });
    expect(listed.body).not.toContain("tts-secret");
    await app.close();
  });

  it("合成时把 Agent 音色覆盖传给服务，并流式返回音频", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-routes-"));
    roots.push(root);
    const app = Fastify();
    registerApiV1Namespace(app);
    const synthesize = vi.fn(async () => ({
      content: Readable.from([Buffer.from([1, 2, 3])]),
      mediaType: "audio/pcm",
    }));
    registerTtsRoutes(app, {
      authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService,
      configs: new TtsConfigService(join(root, "tts.json")),
      synthesize: { synthesize },
      isProfileInUse: vi.fn(async () => false),
      getAgentTtsProfile: vi.fn(async () => ({ profileId: "profile-1", voice: "Cherry" })),
    });
    await app.ready();

    const response = await app.inject({ method: "POST", url: "/api/v1/agents/agent-1/tts", payload: { input: "你好" } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("audio/pcm");
    expect([...response.rawPayload]).toEqual([1, 2, 3]);
    expect(synthesize).toHaveBeenCalledWith("profile-1", "你好", expect.any(AbortSignal), "Cherry");
    await app.close();
  });

  it("真实 HTTP 响应在音频流结束前发送首块，并在客户端取消后中止上游", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-routes-"));
    roots.push(root);
    const app = Fastify();
    registerApiV1Namespace(app);
    const audio = new PassThrough();
    let upstreamSignal: AbortSignal | undefined;
    registerTtsRoutes(app, {
      authService: { isAuthenticated: vi.fn(async () => true) } as unknown as AuthService,
      configs: new TtsConfigService(join(root, "tts.json")),
      synthesize: {
        synthesize: vi.fn(async (_profileId, _input, signal) => {
          upstreamSignal = signal;
          return { content: audio, mediaType: "audio/pcm" };
        }),
      },
      isProfileInUse: vi.fn(async () => false),
      getAgentTtsProfile: vi.fn(async () => ({ profileId: "profile-1" })),
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const responsePromise = fetch(`${address}/api/v1/agents/agent-1/tts`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "你好" }),
    });
    await vi.waitFor(() => expect(upstreamSignal).toBeDefined());

    audio.write(Buffer.from([1, 2]));
    const response = await responsePromise;
    const first = await response.body?.getReader().read();

    expect(first?.done).toBe(false);
    expect([...new Uint8Array(first?.value ?? [])]).toEqual([1, 2]);
    expect(audio.readableEnded).toBe(false);
    controller.abort();
    await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
    audio.destroy();
    await app.close();
  });
});
