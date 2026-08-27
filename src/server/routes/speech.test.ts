// @vitest-environment node

import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApiV1Namespace } from "../http/api-versioning";
import type { AuthService } from "./auth";
import { registerSpeechRoutes } from "./speech";

const apps: ReturnType<typeof Fastify>[] = [];

describe("本机 Whisper 转写路由", () => {
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("鉴权后接收浏览器录音并返回转写文本", async () => {
    const transcribe = vi.fn(async () => ({ text: "你好 BugPaw", language: "zh", duration: 1.25 }));
    const app = await fixture(true, transcribe);
    const response = await app.inject(multipartRequest("audio/webm", "voice.webm", "recording"));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ text: "你好 BugPaw", language: "zh", duration: 1.25 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(transcribe).toHaveBeenCalledWith(expect.any(Buffer), "voice.webm", "audio/webm");
  });

  it("拒绝未登录请求与非音频文件", async () => {
    const transcribe = vi.fn();
    const unauthenticated = await fixture(false, transcribe);
    const denied = await unauthenticated.inject(multipartRequest("audio/webm", "voice.webm", "recording"));
    expect(denied.statusCode).toBe(401);

    const authenticated = await fixture(true, transcribe);
    const invalid = await authenticated.inject(multipartRequest("text/plain", "voice.txt", "recording"));
    expect(invalid.statusCode).toBe(415);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("内部 Whisper 失败时返回稳定的服务不可用错误", async () => {
    const app = await fixture(true, vi.fn(async () => { throw new Error("connection refused"); }));
    const response = await app.inject(multipartRequest("audio/webm", "voice.webm", "recording"));

    expect(response.statusCode).toBe(502);
    expect(response.json().error).toMatchObject({
      code: "MODEL_RUNTIME_UNAVAILABLE",
      message: "本机语音识别暂时不可用，请稍后重试",
    });
  });
});

async function fixture(authenticated: boolean, transcribe: (...args: never[]) => unknown) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerApiV1Namespace(app);
  await app.register(multipart);
  registerSpeechRoutes(app, {
    authService: { isAuthenticated: vi.fn(async () => authenticated) } as unknown as AuthService,
    whisper: { transcribe: transcribe as never },
  });
  return app;
}

/** 构造无需额外测试依赖的单文件 multipart 请求。 */
function multipartRequest(mediaType: string, filename: string, content: string) {
  const boundary = "bugpaw-speech-test-boundary";
  const payload = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="audio"; filename="${filename}"`,
    `Content-Type: ${mediaType}`,
    "",
    content,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return {
    method: "POST" as const,
    url: "/api/v1/speech/transcriptions",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  };
}
