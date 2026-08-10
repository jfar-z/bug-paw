import type { SpeechAudio } from "./streaming-tts-controller";

const PCM_SAMPLE_RATE = 24_000;
const PCM_STARTUP_BYTES = 4_800;

interface PcmAudioBuffer {
  /** 缓冲区对应的音频时长。 */
  duration: number;

  /** 写入单声道浮点采样。 */
  copyToChannel(samples: Float32Array, channelNumber: number): void;
}

interface PcmAudioBufferSource {
  /** 当前待播放缓冲区。 */
  buffer: PcmAudioBuffer | undefined;

  /** 播放结束回调。 */
  onended: (() => void) | null;

  /** 连接音频输出。 */
  connect(destination: unknown): void;

  /** 在音频时间轴上开始播放。 */
  start(when: number): void;

  /** 立即停止播放。 */
  stop(): void;
}

/** PCM 播放器依赖的最小 Web Audio 上下文接口。 */
export interface PcmAudioContext {
  /** 当前音频时间轴位置。 */
  currentTime: number;

  /** 音频输出节点。 */
  destination: unknown;

  /** 上下文运行状态。 */
  state: string;

  /** 恢复被浏览器挂起的音频上下文。 */
  resume(): Promise<void>;

  /** 释放音频上下文。 */
  close(): Promise<void>;

  /** 创建指定采样率的音频缓冲区。 */
  createBuffer(channels: number, length: number, sampleRate: number): PcmAudioBuffer;

  /** 创建一次性音频源。 */
  createBufferSource(): PcmAudioBufferSource;
}

type SpeechEvent = "ended" | "error";

/**
 * 增量播放 OpenAI Speech PCM 响应。
 * PCM 参数固定为 24 kHz、16 位有符号小端、单声道。
 */
export class PcmStreamAudio implements SpeechAudio {
  /** Fetch 响应读取器。 */
  private reader?: ReadableStreamDefaultReader<Uint8Array>;

  /** 当前 Web Audio 上下文。 */
  private context?: PcmAudioContext;

  /** 尚未达到启动阈值或不足一个采样点的字节。 */
  private pendingBytes = new Uint8Array();

  /** 当前仍在时间轴上的音频源。 */
  private readonly sources = new Set<PcmAudioBufferSource>();

  /** 事件监听器。 */
  private readonly listeners = new Map<SpeechEvent, Array<{ listener: () => void; once: boolean }>>();

  /** 下一块音频的排程起点。 */
  private scheduledUntil = 0;

  /** 是否已经完成启动。 */
  private started = false;

  /** 是否已经成功读完响应体。 */
  private streamEnded = false;

  /** 是否已经排程过至少一个有效采样。 */
  private hasScheduledAudio = false;

  /** 是否由调用方主动取消。 */
  private cancelled = false;

  /** 是否已经发出终止事件。 */
  private settled = false;

  /**
   * @param stream 原始 PCM 字节流
   * @param createContext Web Audio 上下文工厂
   */
  constructor(
    private readonly stream: ReadableStream<Uint8Array>,
    private readonly createContext: () => PcmAudioContext = createBrowserAudioContext,
  ) {}

  /** 启动响应读取；达到约 100 毫秒启动缓冲后立即排程首块。 */
  async play(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.context = this.createContext();
    if (this.context.state === "suspended") await this.context.resume();
    this.scheduledUntil = this.context.currentTime;
    this.reader = this.stream.getReader();
    void this.consume();
  }

  /** 取消网络读取和所有已排程音频。 */
  pause(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.reader) void this.reader.cancel().catch(() => undefined);
    else if (!this.stream.locked) void this.stream.cancel().catch(() => undefined);
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // 已自然结束的 Web Audio 节点无需重复停止。
      }
    }
    this.sources.clear();
    void this.context?.close().catch(() => undefined);
  }

  /** 注册与 HTMLAudioElement 一致的结束和错误监听器。 */
  addEventListener(type: SpeechEvent, listener: () => void, options?: { once?: boolean }): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), { listener, once: options?.once === true }]);
  }

  /** 持续消费网络流，并按采样点边界转换 PCM。 */
  private async consume(): Promise<void> {
    try {
      while (!this.cancelled) {
        const chunk = await this.reader?.read();
        if (!chunk || chunk.done) break;
        this.append(chunk.value);
        if (this.pendingBytes.byteLength >= PCM_STARTUP_BYTES || this.hasScheduledAudio) {
          this.schedulePending(false);
        }
      }
      if (this.cancelled) return;
      this.streamEnded = true;
      this.schedulePending(true);
      if (this.pendingBytes.byteLength !== 0) {
        throw new Error("PCM 音频响应未按 16 位采样对齐");
      }
      if (!this.hasScheduledAudio) {
        throw new Error("PCM 音频响应为空");
      }
      this.finishWhenReady();
    } catch {
      if (!this.cancelled) this.fail();
    }
  }

  /** 将新字节追加到等待区，保留跨分块的半个采样点。 */
  private append(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    const combined = new Uint8Array(this.pendingBytes.byteLength + chunk.byteLength);
    combined.set(this.pendingBytes);
    combined.set(chunk, this.pendingBytes.byteLength);
    this.pendingBytes = combined;
  }

  /** 把当前完整采样转换为 Float32 并排程到连续时间轴。 */
  private schedulePending(flush: boolean): void {
    const byteLength = this.pendingBytes.byteLength - (this.pendingBytes.byteLength % 2);
    if (byteLength === 0 || (!flush && byteLength < PCM_STARTUP_BYTES && !this.hasScheduledAudio)) return;
    const bytes = this.pendingBytes.slice(0, byteLength);
    this.pendingBytes = this.pendingBytes.slice(byteLength);
    const samples = new Float32Array(byteLength / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < samples.length; index += 1) {
      const value = view.getInt16(index * 2, true);
      samples[index] = value < 0 ? value / 32_768 : value / 32_767;
    }
    const context = this.context;
    if (!context) throw new Error("PCM 播放器尚未启动");
    const buffer = context.createBuffer(1, samples.length, PCM_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const startAt = Math.max(context.currentTime, this.scheduledUntil);
    this.scheduledUntil = startAt + buffer.duration;
    this.sources.add(source);
    this.hasScheduledAudio = true;
    source.onended = () => {
      this.sources.delete(source);
      this.finishWhenReady();
    };
    source.start(startAt);
  }

  /** 网络流和全部排程音频都结束后发出 ended。 */
  private finishWhenReady(): void {
    if (!this.streamEnded || this.sources.size > 0 || this.settled || this.cancelled) return;
    this.settled = true;
    void this.context?.close().catch(() => undefined);
    this.emit("ended");
  }

  /** 终止播放器并发出一次 error。 */
  private fail(): void {
    if (this.settled) return;
    this.settled = true;
    void this.context?.close().catch(() => undefined);
    this.emit("error");
  }

  /** 依次触发指定事件，并移除 once 监听器。 */
  private emit(type: SpeechEvent): void {
    const registered = this.listeners.get(type) ?? [];
    this.listeners.set(type, registered.filter((entry) => !entry.once));
    registered.forEach((entry) => entry.listener());
  }
}

/** 创建真实浏览器 AudioContext，并收窄到播放器所需能力。 */
function createBrowserAudioContext(): PcmAudioContext {
  return new AudioContext() as unknown as PcmAudioContext;
}
