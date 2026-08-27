import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ServerSpeechInputButton } from "./server-speech-input-button";

vi.mock("../api", () => ({ api: { transcribeSpeech: vi.fn() } }));

class FakeMediaRecorder {
  static readonly instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);

  readonly mimeType: string;
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start = vi.fn(() => { this.state = "recording"; });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  });
}

describe("ServerSpeechInputButton", () => {
  const stopTrack = vi.fn();

  beforeEach(() => {
    FakeMediaRecorder.instances.length = 0;
    FakeMediaRecorder.isTypeSupported.mockClear();
    stopTrack.mockClear();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
    });
    vi.mocked(api.transcribeSpeech).mockReset().mockResolvedValue({ text: "测试语音", language: "zh", duration: 1 });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("按住录音并在松开后上传到本机 Whisper", async () => {
    const onTranscript = vi.fn();
    render(<ServerSpeechInputButton onTranscript={onTranscript} onError={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 1 });
    await screen.findByText("正在聆听 · 松开结束");
    fireEvent.pointerUp(screen.getByRole("button", { name: "松开结束语音输入" }), { pointerId: 1 });

    await waitFor(() => expect(api.transcribeSpeech).toHaveBeenCalledOnce());
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith("测试语音"));
    expect(stopTrack).toHaveBeenCalledOnce();
  });

  it("转写期间禁用按钮并显示服务端处理状态", async () => {
    let resolveTranscription!: (value: { text: string; language: string; duration: number }) => void;
    vi.mocked(api.transcribeSpeech).mockReturnValue(new Promise((resolve) => { resolveTranscription = resolve; }));
    render(<ServerSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 2 });
    await screen.findByText("正在聆听 · 松开结束");
    fireEvent.pointerUp(screen.getByRole("button", { name: "松开结束语音输入" }), { pointerId: 2 });

    expect(await screen.findByText("本机 Whisper 正在转写…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "按住说话" })).toBeDisabled();
    resolveTranscription({ text: "完成", language: "zh", duration: 1 });
  });

  it("麦克风权限被拒绝时返回准确提示", async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    const onError = vi.fn();
    render(<ServerSpeechInputButton onTranscript={vi.fn()} onError={onError} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 3 });

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith(
      "浏览器未允许使用麦克风，请在地址栏权限设置中允许后重试。",
    ));
  });
});
