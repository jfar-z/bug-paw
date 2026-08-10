import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TtsConfigService } from "./tts-config-service";
import { TtsSynthesisService } from "./tts-synthesis-service";

describe("语音合成服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("通过已选配置立即返回上游音频流，并优先使用 Agent 音色", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-synthesis-"));
    roots.push(root);
    const configs = new TtsConfigService(join(root, "tts.json"));
    const created = await configs.create({
      name: "中文语音",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      apiKey: randomUUID(),
    });
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    });
    const fetchMock = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    }));
    const service = new TtsSynthesisService(configs, fetchMock);

    const resultPromise = service.synthesize(created.profile.id, "你好", new AbortController().signal, "Cherry");
    upstream?.enqueue(new Uint8Array([1, 2, 3]));
    const result = await resultPromise;
    const iterator = result.content[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(result.mediaType).toBe("audio/mpeg");
    expect([...first.value]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledWith("https://tts.example/v1/audio/speech", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"voice":"Cherry"'),
    }));
    upstream?.close();
    await iterator.return?.();
  });

  it("上游失败时只返回安全错误", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-synthesis-"));
    roots.push(root);
    const configs = new TtsConfigService(join(root, "tts.json"));
    const created = await configs.create({
      name: "中文语音",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "mp3",
      apiKey: randomUUID(),
    });
    const service = new TtsSynthesisService(configs, async () => new Response("provider failure", { status: 502 }));

    await expect(service.synthesize(created.profile.id, "你好", new AbortController().signal)).rejects.toThrow("语音合成服务暂时不可用");
  });

  it("Agent 未覆盖音色时使用 TTS 配置的默认音色", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-synthesis-"));
    roots.push(root);
    const configs = new TtsConfigService(join(root, "tts.json"));
    const created = await configs.create({
      name: "默认音色",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      apiKey: randomUUID(),
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "Content-Type": "audio/pcm" },
    }));
    const service = new TtsSynthesisService(configs, fetchMock);

    const result = await service.synthesize(created.profile.id, "你好", new AbortController().signal);
    for await (const _chunk of result.content) {
      // 消费返回流，确保测试覆盖完整的服务端转发路径。
    }

    expect(fetchMock).toHaveBeenCalledWith("https://tts.example/v1/audio/speech", expect.objectContaining({
      body: expect.stringContaining('"voice":"alloy"'),
    }));
  });

  it("在返回音频流前拒绝空响应和不兼容的 PCM 参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "tts-synthesis-"));
    roots.push(root);
    const configs = new TtsConfigService(join(root, "tts.json"));
    const created = await configs.create({
      name: "PCM 音色",
      baseUrl: "https://tts.example/v1",
      model: "tts-1",
      voice: "alloy",
      responseFormat: "pcm",
      apiKey: randomUUID(),
    });
    const empty = new TtsSynthesisService(configs, async () => new Response(new Uint8Array(), {
      status: 200,
      headers: { "Content-Type": "audio/pcm" },
    }));
    const cancelIncompatible = vi.fn();
    const incompatibleBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel: cancelIncompatible,
    });
    const incompatible = new TtsSynthesisService(configs, async () => new Response(incompatibleBody, {
      status: 200,
      headers: { "Content-Type": "audio/pcm; rate=16000; channels=2" },
    }));
    const oversized = new TtsSynthesisService(configs, async () => new Response(new Uint8Array([1, 2]), {
      status: 200,
      headers: { "Content-Type": "audio/pcm", "Content-Length": String(20 * 1024 * 1024 + 1) },
    }));

    await expect(empty.synthesize(created.profile.id, "你好", new AbortController().signal)).rejects.toThrow("语音合成服务暂时不可用");
    await expect(incompatible.synthesize(created.profile.id, "你好", new AbortController().signal)).rejects.toThrow("语音合成服务暂时不可用");
    expect(cancelIncompatible).toHaveBeenCalledOnce();
    await expect(oversized.synthesize(created.profile.id, "你好", new AbortController().signal)).rejects.toThrow("语音合成服务暂时不可用");
  });
});
