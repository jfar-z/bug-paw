import { Mic } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api } from "../api";

const MAX_RECORDING_MS = 120_000;
const AUDIO_TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"] as const;

type SpeechPhase = "idle" | "starting" | "recording" | "transcribing";

interface ServerSpeechInputButtonProps {
  disabled?: boolean;
  onTranscript(transcript: string): void;
  onError(message: string): void;
}

/** 选择当前浏览器可以稳定录制并由 Whisper 解码的音频格式。 */
function supportedAudioType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return AUDIO_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** 将麦克风权限与设备错误转换为可操作的中文提示。 */
function microphoneErrorMessage(error: unknown): string {
  if (error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "SecurityError")) {
    return "浏览器未允许使用麦克风，请在地址栏权限设置中允许后重试。";
  }
  if (error instanceof DOMException && (error.name === "NotFoundError" || error.name === "DevicesNotFoundError")) {
    return "未检测到可用麦克风，请检查设备连接后重试。";
  }
  return "无法启动麦克风录音，请稍后重试。";
}

/** 提供按住录音、松开后交给本机服务器 Whisper 转写的语音入口。 */
export function ServerSpeechInputButton({ disabled = false, onTranscript, onError }: ServerSpeechInputButtonProps) {
  const audioType = supportedAudioType();
  const [phase, setPhase] = useState<SpeechPhase>("idle");
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const chunksRef = useRef<Blob[]>([]);
  const holdingRef = useRef(false);
  const mountedRef = useRef(true);
  const timeoutRef = useRef<number | undefined>(undefined);

  const releaseStream = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = undefined;
  };

  const clearRecordingTimeout = () => {
    if (timeoutRef.current !== undefined) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = undefined;
  };

  useEffect(() => () => {
    mountedRef.current = false;
    holdingRef.current = false;
    clearRecordingTimeout();
    const recorder = recorderRef.current;
    recorderRef.current = undefined;
    if (recorder?.state === "recording") recorder.stop();
    releaseStream();
  }, []);

  const transcribe = async (chunks: Blob[], type: string) => {
    if (!mountedRef.current) return;
    const audio = new Blob(chunks, { type });
    if (!audio.size) {
      setPhase("idle");
      onError("未录制到语音，请按住麦克风后再开始说话。");
      return;
    }
    setPhase("transcribing");
    try {
      const result = await api.transcribeSpeech(audio);
      if (!mountedRef.current) return;
      setPhase("idle");
      if (result.text) {
        onTranscript(result.text);
      } else {
        onError("未识别到清晰语音，请靠近麦克风后重试。");
      }
    } catch (error) {
      if (!mountedRef.current) return;
      setPhase("idle");
      onError(error instanceof Error ? error.message : "本机语音识别暂时不可用，请稍后重试。");
    }
  };

  const beginHolding = async () => {
    if (disabled || !audioType || holdingRef.current || phase !== "idle") return;
    holdingRef.current = true;
    setPhase("starting");
    onError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mountedRef.current || !holdingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        if (mountedRef.current) setPhase("idle");
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: audioType });
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        clearRecordingTimeout();
        recorder.onstop = null;
        recorderRef.current = undefined;
        releaseStream();
        if (!mountedRef.current) return;
        setPhase("idle");
        onError("麦克风录音中断，请稍后重试。");
      };
      recorder.onstop = () => {
        clearRecordingTimeout();
        recorderRef.current = undefined;
        releaseStream();
        const chunks = chunksRef.current;
        chunksRef.current = [];
        void transcribe(chunks, recorder.mimeType || audioType);
      };
      recorder.start(250);
      setPhase("recording");
      timeoutRef.current = window.setTimeout(() => {
        holdingRef.current = false;
        if (recorder.state === "recording") recorder.stop();
      }, MAX_RECORDING_MS);
    } catch (error) {
      holdingRef.current = false;
      releaseStream();
      if (!mountedRef.current) return;
      setPhase("idle");
      onError(microphoneErrorMessage(error));
    }
  };

  const finishHolding = () => {
    if (!holdingRef.current) return;
    holdingRef.current = false;
    clearRecordingTimeout();
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") recorder.stop();
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    void beginHolding();
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
    void beginHolding();
  };

  const handleKeyUp = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    finishHolding();
  };

  const supported = Boolean(audioType && navigator.mediaDevices?.getUserMedia);
  const active = phase === "starting" || phase === "recording";
  const status = phase === "starting"
    ? "正在启动麦克风…"
    : phase === "recording"
      ? "正在聆听 · 松开结束"
      : phase === "transcribing"
        ? "本机 Whisper 正在转写…"
        : "";
  const label = active ? "松开结束语音输入" : "按住说话";
  const title = supported ? label : "当前浏览器不支持麦克风录音";

  return <span className="server-speech-input">
    <button
      type="button"
      className={`icon-button server-speech-input__button${active ? " is-listening" : ""}`}
      aria-label={supported ? label : title}
      aria-pressed={active}
      disabled={disabled || !supported || phase === "transcribing"}
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
    {status ? <span className="server-speech-input__status" role="status">{status}</span> : null}
  </span>;
}
