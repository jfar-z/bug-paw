interface VersionedProjection {
  sessionId: string;
  version: number;
}

interface PendingProjection<T> {
  projection: T;
  debounce?: ReturnType<typeof setTimeout>;
  deadline?: ReturnType<typeof setTimeout>;
  writing?: Promise<void>;
  persistedVersion: number;
}

/** 合并高频 Projection 更新，并保证同一 Session 的版本单调落盘。 */
export class CheckpointWriter<T extends VersionedProjection> {
  private readonly writeProjection: (projection: T) => Promise<void>;
  private readonly debounceMs: number;
  private readonly maxDelayMs: number;
  private readonly onError: (error: unknown) => void;
  private readonly states = new Map<string, PendingProjection<T>>();

  constructor(options: {
    write(projection: T): Promise<void>;
    debounceMs?: number;
    maxDelayMs?: number;
    onError?: (error: unknown) => void;
  }) {
    this.writeProjection = options.write;
    this.debounceMs = options.debounceMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 5_000;
    this.onError = options.onError ?? (() => undefined);
  }

  schedule(projection: T): void {
    const state = this.states.get(projection.sessionId) ?? { projection, persistedVersion: -1 };
    if (projection.version >= state.projection.version) state.projection = projection;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(() => {
      void this.flushSession(projection.sessionId).catch(this.onError);
    }, this.debounceMs);
    state.debounce.unref?.();
    if (!state.deadline) {
      state.deadline = setTimeout(() => {
        void this.flushSession(projection.sessionId).catch(this.onError);
      }, this.maxDelayMs);
      state.deadline.unref?.();
    }
    this.states.set(projection.sessionId, state);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.states.keys()].map((sessionId) => this.flushSession(sessionId)));
  }

  async dispose(): Promise<void> {
    await this.flush();
    this.states.forEach(clearTimers);
    this.states.clear();
  }

  /** 仅用于运行状态诊断，确认已持久化 Session 不会永久滞留。 */
  get pendingStateCount(): number {
    return this.states.size;
  }

  private async flushSession(sessionId: string): Promise<void> {
    const state = this.states.get(sessionId);
    if (!state) return;
    clearTimers(state);
    if (state.writing) {
      await state.writing;
      return this.flushSession(sessionId);
    }
    const projection = state.projection;
    if (projection.version <= state.persistedVersion) {
      if (this.states.get(sessionId) === state) this.states.delete(sessionId);
      return;
    }
    state.writing = this.writeProjection(projection).then(() => {
      state.persistedVersion = Math.max(state.persistedVersion, projection.version);
    }).finally(() => { state.writing = undefined; });
    await state.writing;
    if (state.projection.version > state.persistedVersion) {
      await this.flushSession(sessionId);
      return;
    }
    // 只有对象身份和 Projection 均未在写入期间更新时才删除，避免并发 schedule 丢更新。
    if (this.states.get(sessionId) === state && state.projection === projection && !state.writing) {
      clearTimers(state);
      this.states.delete(sessionId);
    }
  }
}

function clearTimers<T extends VersionedProjection>(state: PendingProjection<T>): void {
  if (state.debounce) clearTimeout(state.debounce);
  if (state.deadline) clearTimeout(state.deadline);
  state.debounce = undefined;
  state.deadline = undefined;
}
