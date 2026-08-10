import { prepareSpeechSegments } from "./speech-text";

/** 控制器使用的最小浏览器音频接口。 */
export interface SpeechAudio {
  /** 开始播放当前音频。 */
  play(): Promise<void>;

  /** 立即暂停当前音频。 */
  pause(): void;

  /** 监听播放完成或失败。 */
  addEventListener(type: "ended" | "error", listener: () => void, options?: { once?: boolean }): void;
}

/** 已创建音频及其资源释放动作。 */
export interface SpeechAudioResource {
  /** 可由队列播放的音频实例。 */
  audio: SpeechAudio;

  /** 释放响应流、对象 URL 或其他底层资源。 */
  release(): void;
}

/** 当前 TTS 播放所属消息和阶段。 */
export interface SpeechPlaybackState {
  /** 正在等待或播放的 Agent 消息标识。 */
  messageId?: string;

  /** 当前控制器阶段。 */
  phase: "idle" | "loading" | "playing";
}

interface StreamingTtsControllerOptions {
  /** 请求一段音频；PCM 可直接返回流式播放器资源。 */
  request(text: string, signal: AbortSignal): Promise<Blob | SpeechAudioResource>;

  /** 用对象 URL 创建浏览器音频实例。 */
  createAudio(url: string): SpeechAudio;

  /** 发布活动消息和播放阶段。 */
  onStateChange(state: SpeechPlaybackState): void;

  /** 上报一次真实的合成或播放错误。 */
  onError(error: unknown): void;
}

interface ReadyAudio {
  /** 待播放音频实例。 */
  audio: SpeechAudio;

  /** 释放该音频占用的资源。 */
  release(): void;
}

interface PlayingAudio extends ReadyAudio {
  /** 取消时解除播放等待，避免遗留异步任务。 */
  cancelWait(): void;
}

interface PlaybackSession {
  /** 用于隔离迟到异步结果的播放代次。 */
  generation: number;

  /** 当前 Agent 消息标识。 */
  messageId: string;

  /** 取消本代全部网络请求。 */
  abortController: AbortController;

  /** 已经调度过的确定性文本片段。 */
  scheduledSegments: string[];

  /** 等待合成的文本片段。 */
  pendingTexts: string[];

  /** 已合成但尚未播放的音频。 */
  readyAudios: ReadyAudio[];

  /** 当前正在播放的音频。 */
  currentAudio?: PlayingAudio;

  /** 是否已有合成请求在途。 */
  synthesizing: boolean;

  /** 是否已收到回答完成信号。 */
  completed: boolean;

  /** 当前代次是否已上报错误。 */
  errorReported: boolean;
}

/**
 * 顺序合成并播放 Agent 正文，在当前片段播放时有界预取下一片段。
 * 同一时间只允许一个消息活动，停止后所有迟到结果都会被丢弃。
 */
export class StreamingTtsController {
  /** 当前活动播放会话。 */
  private session?: PlaybackSession;

  /** 单调递增的播放代次。 */
  private generation = 0;

  constructor(private readonly options: StreamingTtsControllerOptions) {}

  /** 开始一条消息；重复开始同一消息不会重置已调度进度。 */
  start(messageId: string): void {
    if (this.session?.messageId === messageId) {
      return;
    }
    if (this.session) {
      this.cancelSession(this.session, false);
    }
    this.session = {
      generation: ++this.generation,
      messageId,
      abortController: new AbortController(),
      scheduledSegments: [],
      pendingTexts: [],
      readyAudios: [],
      synthesizing: false,
      completed: false,
      errorReported: false,
    };
    this.publish({ messageId, phase: "loading" });
  }

  /** 接收累计 Markdown；流式阶段只调度稳定片段，完成时补齐尾部。 */
  update(messageId: string, markdown: string, completed: boolean): void {
    const session = this.readSession(messageId);
    if (!session) {
      return;
    }
    const segments = prepareSpeechSegments(markdown, completed);
    const scheduledPrefixMatches = session.scheduledSegments.every(
      (segment, index) => segments[index] === segment,
    );
    if (!scheduledPrefixMatches) {
      return;
    }
    session.pendingTexts.push(...segments.slice(session.scheduledSegments.length));
    session.scheduledSegments = segments;
    session.completed = session.completed || completed;
    this.pump(session);
  }

  /** 停止当前消息；指定其他消息标识时不影响活动播放。 */
  stop(messageId?: string): void {
    const session = this.session;
    if (!session || (messageId !== undefined && session.messageId !== messageId)) {
      return;
    }
    this.cancelSession(session, true);
  }

  /** 销毁控制器并释放全部浏览器资源。 */
  destroy(): void {
    this.stop();
  }

  /** 同时推进合成生产者和播放消费者。 */
  private pump(session: PlaybackSession): void {
    if (!this.isActive(session)) {
      return;
    }
    void this.playNext(session);
    void this.synthesizeNext(session);
    this.settleState(session);
  }

  /** 在当前播放期间最多准备下一段音频。 */
  private async synthesizeNext(session: PlaybackSession): Promise<void> {
    const preparedCount = session.readyAudios.length + (session.currentAudio ? 1 : 0);
    if (!this.isActive(session)
      || session.synthesizing
      || session.pendingTexts.length === 0
      || preparedCount >= 2) {
      return;
    }
    const text = session.pendingTexts.shift();
    if (!text) {
      return;
    }
    session.synthesizing = true;
    try {
      const result = await this.options.request(text, session.abortController.signal);
      if (!this.isActive(session)) {
        if (!(result instanceof Blob)) result.release();
        return;
      }
      if (result instanceof Blob) {
        const url = URL.createObjectURL(result);
        if (!this.isActive(session)) {
          URL.revokeObjectURL(url);
          return;
        }
        session.readyAudios.push({
          audio: this.options.createAudio(url),
          release: () => URL.revokeObjectURL(url),
        });
      } else {
        session.readyAudios.push(result);
      }
    } catch (error) {
      if (this.isActive(session)) {
        this.failSession(session, error);
      }
    } finally {
      session.synthesizing = false;
      if (this.isActive(session)) {
        this.pump(session);
      }
    }
  }

  /** 严格按 ready 队列顺序播放一段音频。 */
  private async playNext(session: PlaybackSession): Promise<void> {
    if (!this.isActive(session) || session.currentAudio || session.readyAudios.length === 0) {
      return;
    }
    const ready = session.readyAudios.shift();
    if (!ready) {
      return;
    }
    let cancelWait: () => void = () => undefined;
    const completion = new Promise<void>((resolve, reject) => {
      cancelWait = resolve;
      ready.audio.addEventListener("ended", resolve, { once: true });
      ready.audio.addEventListener("error", () => reject(new Error("音频播放失败")), { once: true });
    });
    session.currentAudio = { ...ready, cancelWait };
    this.publish({ messageId: session.messageId, phase: "playing" });
    try {
      await ready.audio.play();
      await completion;
      if (!this.isActive(session)) {
        return;
      }
      ready.release();
      session.currentAudio = undefined;
      this.pump(session);
    } catch (error) {
      if (this.isActive(session)) {
        this.failSession(session, error);
      }
    }
  }

  /** 在无剩余工作时发布等待后续正文或完成为空闲。 */
  private settleState(session: PlaybackSession): void {
    if (!this.isActive(session)
      || session.synthesizing
      || session.pendingTexts.length > 0
      || session.readyAudios.length > 0
      || session.currentAudio) {
      return;
    }
    if (session.completed) {
      this.session = undefined;
      this.publish({ phase: "idle" });
      return;
    }
    this.publish({ messageId: session.messageId, phase: "loading" });
  }

  /** 上报一次真实错误并终止当前代次。 */
  private failSession(session: PlaybackSession, error: unknown): void {
    if (!session.errorReported) {
      session.errorReported = true;
      this.options.onError(error);
    }
    this.cancelSession(session, true);
  }

  /** 同步取消一个会话并清理音频与对象 URL。 */
  private cancelSession(session: PlaybackSession, publishIdle: boolean): void {
    if (this.session === session) {
      this.session = undefined;
    }
    this.generation += 1;
    session.abortController.abort();
    session.pendingTexts.length = 0;
    for (const ready of session.readyAudios.splice(0)) {
      ready.release();
    }
    if (session.currentAudio) {
      session.currentAudio.audio.pause();
      session.currentAudio.cancelWait();
      session.currentAudio.release();
      session.currentAudio = undefined;
    }
    if (publishIdle) {
      this.publish({ phase: "idle" });
    }
  }

  /** 获取未取消且消息匹配的活动会话。 */
  private readSession(messageId: string): PlaybackSession | undefined {
    const session = this.session;
    return session?.messageId === messageId && !session.abortController.signal.aborted
      ? session
      : undefined;
  }

  /** 判断异步任务是否仍属于当前播放代次。 */
  private isActive(session: PlaybackSession): boolean {
    return this.session === session
      && session.generation === this.generation
      && !session.abortController.signal.aborted;
  }

  /** 向 React 页面发布不可变播放状态。 */
  private publish(state: SpeechPlaybackState): void {
    this.options.onStateChange(state);
  }
}
