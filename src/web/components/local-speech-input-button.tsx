import { Mic } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const LOCAL_SPEECH_LANGUAGE = "zh-CN";

type LocalSpeechAvailability = "available" | "downloadable" | "downloading" | "unavailable";
type LocalSpeechPhase = "idle" | "preparing" | "ready" | "starting" | "listening" | "processing";

interface LocalSpeechRecognitionAlternative {
  transcript: string;
}

interface LocalSpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: LocalSpeechRecognitionAlternative;
}

interface LocalSpeechRecognitionResultList {
  readonly length: number;
  readonly [index: number]: LocalSpeechRecognitionResult;
}

interface LocalSpeechRecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: LocalSpeechRecognitionResultList;
}

interface LocalSpeechRecognitionErrorEvent extends Event {
  readonly error: string;
}

interface LocalSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  processLocally: boolean;
  onstart: (() => void) | null;
  onresult: ((event: LocalSpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: LocalSpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

interface LocalSpeechRecognitionConstructor {
  new(): LocalSpeechRecognition;
  readonly prototype: LocalSpeechRecognition;
  available(options: LocalSpeechOptions): Promise<LocalSpeechAvailability>;
  install(options: LocalSpeechOptions): Promise<boolean>;
}

interface LocalSpeechOptions {
  langs: string[];
  processLocally: true;
}

interface LocalSpeechInputButtonProps {
  disabled?: boolean;
  onTranscript(transcript: string): void;
  onError(message: string): void;
}

/**
 * 读取同时支持本地处理与语言包管理的 Chrome 语音识别实现。
 */
function getLocalSpeechRecognition(): LocalSpeechRecognitionConstructor | undefined {
  const speechWindow = window as typeof window & { SpeechRecognition?: LocalSpeechRecognitionConstructor };
  const Recognition = speechWindow.SpeechRecognition;
  if (!Recognition
    || typeof Recognition.available !== "function"
    || typeof Recognition.install !== "function"
    || !("processLocally" in Recognition.prototype)) return undefined;
  return Recognition;
}

/**
 * 将浏览器错误映射为可操作的中文提示，不把底层实现细节暴露给用户。
 */
function speechErrorMessage(error: string): string | undefined {
  if (error === "aborted") return undefined;
  if (error === "not-allowed" || error === "service-not-allowed") {
    return "Chrome 未允许使用麦克风，请在地址栏权限设置中允许后重试。";
  }
  if (error === "audio-capture") return "未检测到可用麦克风，请检查设备连接后重试。";
  if (error === "no-speech") return "未识别到语音，请按住麦克风后再开始说话。";
  if (error === "language-not-supported" || error === "language-unavailable") {
    return "Chrome 本地中文语音包不可用，请更新浏览器后重试。";
  }
  return "本地语音识别未完成，请稍后重试。";
}

/**
 * 提取一次识别事件中的最终文本，忽略仍可能变化的临时结果。
 */
function finalTranscript(event: LocalSpeechRecognitionResultEvent): string {
  let transcript = "";
  for (let index = event.resultIndex; index < event.results.length; index += 1) {
    const result = event.results[index];
    if (result?.isFinal) transcript += result[0]?.transcript ?? "";
  }
  return transcript.trim();
}

const LOCAL_SPEECH_OPTIONS: LocalSpeechOptions = {
  langs: [LOCAL_SPEECH_LANGUAGE],
  processLocally: true,
};

/**
 * 提供严格本地处理的按住说话入口；松开后仅回填草稿，不触发发送。
 */
export function LocalSpeechInputButton({ disabled = false, onTranscript, onError }: LocalSpeechInputButtonProps) {
  const Recognition = getLocalSpeechRecognition();
  const [phase, setPhase] = useState<LocalSpeechPhase>("idle");
  const recognitionRef = useRef<LocalSpeechRecognition | undefined>(undefined);
  const holdingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    holdingRef.current = false;
    recognitionRef.current?.abort();
    recognitionRef.current = undefined;
  }, []);

  useEffect(() => {
    if (phase !== "ready") return;
    const timer = window.setTimeout(() => setPhase("idle"), 2600);
    return () => window.clearTimeout(timer);
  }, [phase]);

  const fail = (message: string) => {
    recognitionRef.current = undefined;
    if (!mountedRef.current) return;
    setPhase("idle");
    onError(message);
  };

  const startRecognition = () => {
    if (!Recognition || !holdingRef.current) return;
    const recognition = new Recognition();
    if (!("processLocally" in recognition)) {
      fail("当前 Chrome 不支持本地语音识别，请更新浏览器后重试。");
      return;
    }
    recognition.lang = LOCAL_SPEECH_LANGUAGE;
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.processLocally = true;
    recognition.onstart = () => {
      if (mountedRef.current) setPhase("listening");
    };
    recognition.onresult = (event) => {
      const transcript = finalTranscript(event);
      if (transcript && mountedRef.current) onTranscript(transcript);
    };
    recognition.onerror = (event) => {
      const message = speechErrorMessage(event.error);
      recognitionRef.current = undefined;
      if (!mountedRef.current) return;
      setPhase("idle");
      if (message) onError(message);
    };
    recognition.onend = () => {
      recognitionRef.current = undefined;
      if (mountedRef.current) setPhase("idle");
    };
    recognitionRef.current = recognition;
    setPhase("starting");
    onError("");
    try {
      recognition.start();
    } catch {
      fail("Chrome 无法启动本地语音识别，请稍后重试。");
    }
  };

  const prepareAndStart = async () => {
    if (!Recognition || disabled || phase === "preparing" || recognitionRef.current) return;
    setPhase("preparing");
    onError("");
    try {
      const availability = await Recognition.available(LOCAL_SPEECH_OPTIONS);
      if (!mountedRef.current) return;
      if (availability === "available") {
        startRecognition();
        return;
      }
      if (availability === "unavailable") {
        fail("Chrome 当前没有可用的本地中文语音包，请更新浏览器后重试。");
        return;
      }
      const installed = await Recognition.install(LOCAL_SPEECH_OPTIONS);
      if (!mountedRef.current) return;
      if (!installed) {
        fail("Chrome 本地中文语音包安装失败，请检查网络与存储空间后重试。");
        return;
      }
      holdingRef.current = false;
      setPhase("ready");
    } catch {
      fail("无法准备 Chrome 本地语音识别，请确认页面权限后重试。");
    }
  };

  const beginHolding = () => {
    if (disabled || !Recognition || holdingRef.current) return;
    holdingRef.current = true;
    void prepareAndStart();
  };

  const finishHolding = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    const recognition = recognitionRef.current;
    if (!recognition) return;
    setPhase("processing");
    try {
      recognition.stop();
    } catch {
      recognition.abort();
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    beginHolding();
  };

  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    finishHolding();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if ((event.key !== " " && event.key !== "Enter") || event.repeat) return;
    event.preventDefault();
    beginHolding();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    finishHolding();
  };

  const supported = Boolean(Recognition);
  const active = phase === "starting" || phase === "listening" || phase === "processing";
  const status = phase === "preparing"
    ? "正在准备本地中文语音包…"
    : phase === "ready"
      ? "本地中文语音包已就绪，请再次按住说话"
      : phase === "starting"
        ? "正在启动本地语音识别…"
        : phase === "listening"
          ? "正在聆听 · 松开结束"
          : phase === "processing"
            ? "正在整理识别结果…"
            : "";
  const label = active ? "松开结束语音输入" : "按住说话";
  const title = supported ? label : "当前浏览器不支持 Chrome 本地语音识别";

  return <span className="local-speech-input">
    <button
      type="button"
      className={`icon-button local-speech-input__button${active ? " is-listening" : ""}`}
      aria-label={supported ? label : title}
      aria-pressed={active}
      disabled={disabled || !supported}
      title={title}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerEnd}
      onPointerCancel={handlePointerEnd}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onBlur={finishHolding}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Mic size={18} aria-hidden="true" />
    </button>
    {status ? <span className="local-speech-input__status" role="status">{status}</span> : null}
  </span>;
}
