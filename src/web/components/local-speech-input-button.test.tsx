import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalSpeechInputButton } from "./local-speech-input-button";

type SpeechAvailability = "available" | "downloadable" | "downloading" | "unavailable";

class FakeSpeechRecognition extends EventTarget {
  static readonly instances: FakeSpeechRecognition[] = [];
  static available = vi.fn<(options: { langs: string[] }) => Promise<SpeechAvailability>>();
  static install = vi.fn(async () => true);

  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  processLocally = false;
  onstart: (() => void) | null = null;
  onresult = null;
  onerror = null;
  onend = null;
  start = vi.fn(() => this.onstart?.());
  stop = vi.fn();
  abort = vi.fn();

  constructor() {
    super();
    FakeSpeechRecognition.instances.push(this);
  }
}

Object.defineProperty(FakeSpeechRecognition.prototype, "processLocally", {
  configurable: true,
  writable: true,
  value: false,
});

describe("LocalSpeechInputButton", () => {
  beforeEach(() => {
    FakeSpeechRecognition.instances.length = 0;
    FakeSpeechRecognition.available.mockReset();
    FakeSpeechRecognition.install.mockReset().mockResolvedValue(true);
    vi.stubGlobal("SpeechRecognition", FakeSpeechRecognition);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("优先使用 Chrome SODA 的普通话规范标签", async () => {
    FakeSpeechRecognition.available.mockResolvedValue("available");
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 1 });

    await waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
    expect(FakeSpeechRecognition.available).toHaveBeenCalledWith({
      langs: ["cmn-Hans-CN"],
      processLocally: true,
    });
    expect(FakeSpeechRecognition.instances[0].lang).toBe("cmn-Hans-CN");
  });

  it("规范标签不可用时回退到 zh-CN", async () => {
    FakeSpeechRecognition.available
      .mockResolvedValueOnce("unavailable")
      .mockResolvedValueOnce("available");
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 2 });

    await waitFor(() => expect(FakeSpeechRecognition.instances).toHaveLength(1));
    expect(FakeSpeechRecognition.available).toHaveBeenNthCalledWith(2, {
      langs: ["zh-CN"],
      processLocally: true,
    });
    expect(FakeSpeechRecognition.instances[0].lang).toBe("zh-CN");
  });

  it("使用命中的规范标签安装中文语言包", async () => {
    FakeSpeechRecognition.available.mockResolvedValue("downloadable");
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={vi.fn()} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 3 });

    await screen.findByText("本地中文语音包已就绪，请再次按住说话");
    expect(FakeSpeechRecognition.install).toHaveBeenCalledWith({
      langs: ["cmn-Hans-CN"],
      processLocally: true,
    });
  });

  it("两个中文标签均不可用时返回准确提示", async () => {
    FakeSpeechRecognition.available.mockResolvedValue("unavailable");
    const onError = vi.fn();
    render(<LocalSpeechInputButton onTranscript={vi.fn()} onError={onError} />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "按住说话" }), { pointerId: 4 });

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith(
      "当前 Chrome 或操作系统未提供可安装的本地中文语音包。",
    ));
    expect(FakeSpeechRecognition.instances).toHaveLength(0);
  });
});
