import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingTtsController, type SpeechAudio, type SpeechPlaybackState } from "./streaming-tts-controller";

class FakeAudio implements SpeechAudio {
  /** 当前音频是否已经开始播放。 */
  played = false;

  /** 当前音频是否已经被暂停。 */
  paused = false;

  private readonly listeners = new Map<"ended" | "error", Array<() => void>>();

  /** 记录播放动作，结束时机由测试显式控制。 */
  async play(): Promise<void> {
    this.played = true;
  }

  /** 记录控制器主动暂停。 */
  pause(): void {
    this.paused = true;
  }

  /** 注册与浏览器 Audio 一致的结束或错误监听器。 */
  addEventListener(type: "ended" | "error", listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** 模拟浏览器完成当前音频播放。 */
  finish(): void {
    this.listeners.get("ended")?.forEach((listener) => listener());
  }

  /** 模拟浏览器播放失败。 */
  fail(): void {
    this.listeners.get("error")?.forEach((listener) => listener());
  }
}

interface ControllerFixture {
  controller: StreamingTtsController;
  requests: Array<{ text: string; signal: AbortSignal }>;
  audios: FakeAudio[];
  states: SpeechPlaybackState[];
  errors: unknown[];
}

beforeEach(() => {
  let nextUrl = 0;
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => `blob:tts-${nextUrl++}`),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("StreamingTtsController", () => {
  it("播放当前片段时预合成下一片段且仍按原顺序播放", async () => {
    const fixture = createFixture();
    const first = `${"甲".repeat(48)}。`;
    const second = `${"乙".repeat(48)}。`;
    const third = `${"丙".repeat(48)}。`;

    fixture.controller.start("message-1");
    fixture.controller.update("message-1", `${first}${second}${third}`, true);
    await flushPromises();

    expect(fixture.requests.map((item) => item.text)).toEqual([first, second]);
    expect(fixture.audios[0].played).toBe(true);
    expect(fixture.audios[1].played).toBe(false);

    fixture.audios[0].finish();
    await flushPromises();

    expect(fixture.requests.map((item) => item.text)).toEqual([first, second, third]);
    expect(fixture.audios[1].played).toBe(true);
    expect(vi.mocked(URL.revokeObjectURL)).toHaveBeenCalledWith("blob:tts-0");
  });

  it("停止后暂停当前音频并忽略迟到的合成结果", async () => {
    let resolveRequest: ((blob: Blob) => void) | undefined;
    const pending = new Promise<Blob>((resolve) => { resolveRequest = resolve; });
    const fixture = createFixture(() => pending);
    const text = `${"迟到内容".repeat(12)}。`;

    fixture.controller.start("message-1");
    fixture.controller.update("message-1", text, true);
    await flushPromises();
    const signal = fixture.requests[0].signal;

    fixture.controller.stop();
    resolveRequest?.(new Blob([text], { type: "audio/mpeg" }));
    await flushPromises();

    expect(signal.aborted).toBe(true);
    expect(fixture.audios).toHaveLength(0);
    expect(fixture.states.at(-1)).toEqual({ phase: "idle" });
  });

  it("开始另一条消息会取消旧消息并只播放新消息", async () => {
    let resolveOld: ((blob: Blob) => void) | undefined;
    const oldRequest = new Promise<Blob>((resolve) => { resolveOld = resolve; });
    const fixture = createFixture((text) => text.startsWith("旧")
      ? oldRequest
      : Promise.resolve(new Blob([text], { type: "audio/mpeg" })));

    fixture.controller.start("old-message");
    fixture.controller.update("old-message", `${"旧内容".repeat(16)}。`, true);
    await flushPromises();
    const oldSignal = fixture.requests[0].signal;

    fixture.controller.start("new-message");
    fixture.controller.update("new-message", `${"新内容".repeat(16)}。`, true);
    resolveOld?.(new Blob(["old"], { type: "audio/mpeg" }));
    await flushPromises();

    expect(oldSignal.aborted).toBe(true);
    expect(fixture.audios).toHaveLength(1);
    expect(fixture.audios[0].played).toBe(true);
    expect(fixture.states).toContainEqual({ messageId: "new-message", phase: "playing" });
  });

  it("相同句子在回答中重复出现时仍按位置播放", async () => {
    const fixture = createFixture();
    const repeated = `${"重复句子".repeat(12)}。`;

    fixture.controller.start("message-1");
    fixture.controller.update("message-1", `${repeated}${repeated}`, true);
    await flushPromises();

    expect(fixture.requests.map((item) => item.text)).toEqual([repeated, repeated]);
    fixture.audios[0].finish();
    await flushPromises();
    expect(fixture.audios[1].played).toBe(true);
  });

  it("片段失败只上报一次并恢复空闲状态", async () => {
    const failure = new Error("tts failed");
    const fixture = createFixture(() => Promise.reject(failure));

    fixture.controller.start("message-1");
    fixture.controller.update("message-1", `${"失败内容".repeat(12)}。`, true);
    await flushPromises();

    expect(fixture.errors).toEqual([failure]);
    expect(fixture.states.at(-1)).toEqual({ phase: "idle" });
  });

  it("流式片段播放完后继续保持当前消息等待后续正文", async () => {
    const fixture = createFixture();
    const first = `${"流式首段".repeat(12)}。`;

    fixture.controller.start("message-1");
    fixture.controller.update("message-1", first, false);
    await flushPromises();
    fixture.audios[0].finish();
    await flushPromises();

    expect(fixture.states.at(-1)).toEqual({ messageId: "message-1", phase: "loading" });

    fixture.controller.update("message-1", `${first}最终尾句`, true);
    await flushPromises();
    expect(fixture.requests.map((item) => item.text)).toEqual([first, "最终尾句"]);
  });

  it("停止 PCM 等流式音频时同时暂停播放并释放响应资源", async () => {
    const audio = new FakeAudio();
    const release = vi.fn();
    const states: SpeechPlaybackState[] = [];
    const controller = new StreamingTtsController({
      request: async () => ({ audio, release }),
      createAudio: vi.fn(),
      onStateChange: (state) => states.push(state),
      onError: vi.fn(),
    });

    controller.start("stream-message");
    controller.update("stream-message", `${"流式音频".repeat(12)}。`, true);
    await flushPromises();
    controller.stop();

    expect(audio.paused).toBe(true);
    expect(release).toHaveBeenCalledOnce();
    expect(states.at(-1)).toEqual({ phase: "idle" });
  });
});

/** 创建使用真实队列逻辑、仅替换网络和浏览器音频边界的测试控制器。 */
function createFixture(
  requestOverride?: (text: string, signal: AbortSignal) => Promise<Blob>,
): ControllerFixture {
  const requests: Array<{ text: string; signal: AbortSignal }> = [];
  const audios: FakeAudio[] = [];
  const states: SpeechPlaybackState[] = [];
  const errors: unknown[] = [];
  const controller = new StreamingTtsController({
    request: (text, signal) => {
      requests.push({ text, signal });
      return requestOverride?.(text, signal)
        ?? Promise.resolve(new Blob([text], { type: "audio/mpeg" }));
    },
    createAudio: () => {
      const audio = new FakeAudio();
      audios.push(audio);
      return audio;
    },
    onStateChange: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });
  return { controller, requests, audios, states, errors };
}

/** 冲刷控制器内部连续 Promise 微任务。 */
async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}
