import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSpeechInputButton } from "./local-speech-input-button";

interface TestSpeechResult {
  isFinal: boolean;
  0: { transcript: string };
  length: number;
}

class FakeSpeechRecognition extends EventTarget {
  static readonly instances: FakeSpeechRecognition[] = [];
  static available = vi.fn<() => Promise<"available" | "downloadable" | "downloading" | "unavailable">>(async () => "available");
  static install = vi.fn(async () => true);

  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  processLocally = false;
  onstart: (() => void) | null = null;
  onresult: ((event: Event & { resultIndex: number; results: ArrayLike<TestSpeechResult> }) => void) | null = null;
  onerror: ((event: Event & { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    super();
    FakeSpeechRecognition.instances.push(this);
  }

  /** 模拟 Chrome 返回一条最终识别结果。 */
  emitFinal(transcript: string) {
    const results = [{ isFinal: true, 0: { transcript }, length: 1 }];
    this.onresult?.(Object.assign(new Event("result"), { resultIndex: 0, results }));
  }

  /** 模拟 Chrome 语音识别错误。 */
  emitError(error: string) {
    this.onerror?.(Object.assign(new Event("error"), { error }));
  }
}

Object.defineProperty(FakeSpeechRecognition.prototype, "processLocally", {
  configurable: true,
  writable: true,
  value: false,
});

function installFakeSpeechRecognition() {
  vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
}

describe("LocalSpeechInputButton", () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances.length = 0;
    FakeSpeechRecognition.available.mockReset().mockResolvedValue("available");
    FakeSpeechRecognition.install.mockReset().mockResolvedValue(true);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("浏览器不具备严格本地识别能力时禁用入口", () => {
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);

    expect(screen.getByRole("button", { name: "当前浏览器不支持 Chrome 本地语音识别" })).toBeDisabled();
  });

  it("按住启动本地中文识别，松开后停止并回填最终文本", async () => {
    installFakeSpeechRecognition();
    const onTranscript = vi.fn();
    render(<LocalSpeechInputButton onTranscript={onTranscript} onError={vi.fn()} />);
    const button = screen.getByRole("button", { name: "按住说话" });

    fireEvent.pointerDown(button, { pointerId: 7 });
    await waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
    const recognition = FakeSpeechRecognition.instances[0];
    expect(FakeSpeechRecognition.available).toHaveBeenCalledWith({ langs: ["zh-CN"], processLocally: true });
    expect(recognition).toMatchObject({
      continuous: true,
      interimResults: false,
      lang: "zh-CN",
      maxAlternatives: 1,
      processLocally: true,
    });
    expect(button).toHaveAttribute("aria-pressed", "true");

    fireEvent.pointerUp(button, { pointerId: 7 });
    expect(recognition.stop).toHaveBeenCalledTimes(1);
    recognition.emitFinal("  帮我检查这段代码  ");
    recognition.onend?.();

    expect(onTranscript).toHaveBeenCalledWith("帮我检查这段代码");
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
  });

  it("首次使用先安装中文语言包并要求再次按住", async () => {
    installFakeSpeechRecognition();
    FakeSpeechRecognition.available
      .mockResolvedValueOnce("downloadable")
      .mockResolvedValueOnce("available");
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);
    const button = screen.getByRole("button", { name: "按住说话" });

    fireEvent.pointerDown(button, { pointerId: 1 });
    await screen.findByText("本地中文语音包已就绪，请再次按住说话");
    expect(FakeSpeechRecognition.install).toHaveBeenCalledWith({ langs: ["zh-CN"], processLocally: true });
    expect(FakeSpeechRecognition.instances).toHaveLength(0);

    fireEvent.pointerDown(button, { pointerId: 2 });
    await waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
  });

  it("本地中文语言包不可用时不给联网识别降级", async () => {
    installFakeSpeechRecognition();
    FakeSpeechRecognition.available.mockResolvedValue("unavailable");
    const onError = vi.fn();
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={onError} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 3 });

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("本地中文语音包")));
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it("能力检查返回前已经松开时不会迟到启动麦克风", async () => {
    installFakeSpeechRecognition();
    let resolveAvailability: ((value: "available") => void) | undefined;
    FakeSpeechRecognition.available.mockImplementation(() => new Promise((resolve) => {
      resolveAvailability = resolve;
    }));
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);
    const button = screen.getByRole("button", { name: "按住说话" });

    fireEvent.pointerDown(button, { pointerId: 8 });
    fireEvent.pointerUp(button, { pointerId: 8 });
    resolveAvailability?.("available");

    await waitFor(() => expect(FakeSpeechRecognition.available).toHaveBeenCalledTimes(1));
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });

  it("将麦克风权限拒绝映射为可操作提示", async () => {
    installFakeSpeechRecognition();
    const onError = vi.fn();
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={onError} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 4 });
    await waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
    FakeSpeechRecognition.instances[0].emitError("not-allowed");

    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining("地址栏权限设置"));
  });

  it("支持键盘按住空格开始并在松开时停止", async () => {
    installFakeSpeechRecognition();
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);
    const button = screen.getByRole("button", { name: "按住说话" });

    fireEvent.keyDown(button, { key: " " });
    await waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
    fireEvent.keyUp(button, { key: " " });

    expect(FakeSpeechRecognition.instances[0].stop).toHaveBeenCalledTimes(1);
  });
});
