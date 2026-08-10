import { describe, expect, it, vi } from "vitest";

import { PcmStreamAudio, type PcmAudioContext } from "./pcm-stream-audio";

describe("PcmStreamAudio", () => {
  it("在上游响应结束前就排程首段 PCM 音频", async () => {
    let upstream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
      },
    });
    const starts: number[] = [];
    const context = createAudioContext(starts);
    const audio = new PcmStreamAudio(stream, () => context);

    await audio.play();
    // 故意把第一个 16 位采样拆在两个网络分块之间。
    upstream?.enqueue(new Uint8Array(1));
    upstream?.enqueue(new Uint8Array(4_799));
    await flushPromises();

    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeGreaterThanOrEqual(context.currentTime);
    upstream?.close();
  });

  it("拒绝以孤立字节结束的非完整 PCM 采样", async () => {
    const error = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_801));
        controller.close();
      },
    });
    const audio = new PcmStreamAudio(stream, () => createAudioContext([]));
    audio.addEventListener("error", error, { once: true });

    await audio.play();
    await flushPromises();

    expect(error).toHaveBeenCalledOnce();
  });

  it("播放前释放时直接取消原始响应流", () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const audio = new PcmStreamAudio(stream, () => createAudioContext([]));

    audio.pause();

    expect(cancel).toHaveBeenCalledOnce();
  });
});

/** 创建只记录音频排程的 Web Audio 测试替身。 */
function createAudioContext(starts: number[]): PcmAudioContext {
  return {
    currentTime: 1,
    destination: {},
    state: "running",
    resume: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    createBuffer: (_channels, length) => ({
      duration: length / 24_000,
      copyToChannel: vi.fn(),
    }),
    createBufferSource: () => ({
      buffer: undefined,
      onended: null,
      connect: vi.fn(),
      start: vi.fn((when: number) => starts.push(when)),
      stop: vi.fn(),
    }),
  };
}

/** 冲刷播放器内部连续 Promise 微任务。 */
async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}
