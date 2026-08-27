// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { WhisperClient } from "./whisper-client";

describe("WhisperClient", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("向内部服务上传录音并规范化返回文本", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      text: "  本机识别成功  ",
      language: "zh",
      duration: 2.5,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new WhisperClient("http://whisper.internal:7083").transcribe(
      Buffer.from("recording"),
      "voice.webm",
      "audio/webm",
    );

    expect(result).toEqual({ text: "本机识别成功", language: "zh", duration: 2.5 });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("http://whisper.internal:7083/v1/transcriptions"),
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
  });

  it("拒绝内部服务的异常响应", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));

    await expect(new WhisperClient("http://whisper.internal:7083").transcribe(
      Buffer.from("recording"),
      "voice.webm",
      "audio/webm",
    )).rejects.toThrow("Whisper 服务返回 503");
  });
});
