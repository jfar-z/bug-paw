import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";

interface DisposableSession {
  dispose(): void;
}

export interface SessionHandle<T> {
  readonly session: T;
  startTurn(): () => void;
  release(): void;
}

/** 单航班打开 Session，并集中维护 Session Turn 互斥。 */
export class SessionRegistry<T extends DisposableSession> {
  private readonly openSession: (sessionId: string) => Promise<T>;
  private readonly idOf: (session: T) => string;
  private readonly sessions = new Map<string, T>();
  private readonly pending = new Map<string, Promise<T>>();
  private readonly versions = new Map<string, number>();
  private readonly invalidated = new Set<string>();
  private readonly activeTurns = new Set<string>();
  private readonly retained = new Map<string, number>();
  private readonly maxSessions: number;
  private readonly onRemove: (sessionId: string) => void;
  private disposed = false;

  constructor(options: {
    open(sessionId: string): Promise<T>;
    idOf(session: T): string;
    maxSessions?: number;
    onRemove?: (sessionId: string) => void;
  }) {
    this.openSession = options.open;
    this.idOf = options.idOf;
    this.maxSessions = options.maxSessions ?? SYSTEM_LIMITS.runtimeSessionsPerAgent;
    this.onRemove = options.onRemove ?? (() => undefined);
  }

  async open(sessionId: string): Promise<SessionHandle<T>> {
    this.assertOpenable(sessionId);
    const existing = this.sessions.get(sessionId);
    const session = existing ?? await this.openSingleFlight(sessionId);
    this.touch(sessionId, session);
    return this.handle(sessionId, session);
  }

  attach(session: T): SessionHandle<T> {
    const sessionId = this.idOf(session);
    try {
      this.assertOpenable(sessionId);
    } catch (error) {
      session.dispose();
      throw error;
    }
    const existing = this.sessions.get(sessionId);
    if (!existing) this.ensureCapacity();
    if (existing && existing !== session) session.dispose();
    else this.sessions.set(sessionId, session);
    return this.handle(sessionId, existing ?? session);
  }

  peek(sessionId: string): T | undefined {
    const session = this.sessions.get(sessionId);
    if (session) this.touch(sessionId, session);
    return session;
  }

  /** 在 SSE 订阅期间固定 Session，防止 LRU 淘汰正在消费事件的连接。 */
  retain(sessionId: string): () => void {
    if (!this.sessions.has(sessionId)) throw new DomainError("SESSION_NOT_FOUND", "Session 不存在");
    this.retained.set(sessionId, (this.retained.get(sessionId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.retained.get(sessionId) ?? 1) - 1;
      if (next > 0) this.retained.set(sessionId, next);
      else this.retained.delete(sessionId);
    };
  }

  startTurn(sessionId: string): () => void {
    if (!this.sessions.has(sessionId)) throw new DomainError("SESSION_NOT_FOUND", "Session 不存在");
    if (this.activeTurns.has(sessionId)) throw new DomainError("SESSION_BUSY", "Session 正在生成中");
    this.activeTurns.add(sessionId);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activeTurns.delete(sessionId);
    };
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** 永久失效指定 Session，并拒绝失效前启动的迟到 open 结果。 */
  invalidate(sessionId: string): void {
    this.invalidated.add(sessionId);
    this.versions.set(sessionId, this.versionOf(sessionId) + 1);
    this.evict(sessionId);
  }

  /** 删除事务回滚后允许 Session 再次打开。 */
  async restore(sessionId: string): Promise<void> {
    await this.settlePending(sessionId);
    this.invalidated.delete(sessionId);
    this.versions.delete(sessionId);
  }

  /** 永久删除提交后，在迟到 open 已被拒绝后释放墓碑与版本元数据。 */
  async finalizeDeletion(sessionId: string): Promise<void> {
    await this.settlePending(sessionId);
    this.invalidated.delete(sessionId);
    this.versions.delete(sessionId);
  }

  /** 仅用于运行状态诊断，确认删除历史不会形成无界集合。 */
  get trackedDeletionCount(): number {
    return this.invalidated.size + this.versions.size;
  }

  private evict(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    session?.dispose();
    this.sessions.delete(sessionId);
    this.activeTurns.delete(sessionId);
    this.retained.delete(sessionId);
    this.onRemove(sessionId);
  }

  dispose(): void {
    this.disposed = true;
    this.sessions.forEach((session) => session.dispose());
    this.sessions.clear();
    this.pending.clear();
    this.activeTurns.clear();
    this.retained.clear();
    this.invalidated.clear();
    this.versions.clear();
  }

  private openSingleFlight(sessionId: string): Promise<T> {
    const pending = this.pending.get(sessionId);
    if (pending) return pending;
    this.ensureCapacity();
    const version = this.versionOf(sessionId);
    let creation: Promise<T>;
    creation = this.openSession(sessionId).then((session) => {
      const actualId = this.idOf(session);
      if (actualId !== sessionId || this.disposed || this.invalidated.has(sessionId) || version !== this.versionOf(sessionId)) {
        session.dispose();
        throw new DomainError("SESSION_NOT_FOUND", "Session 已失效或标识不匹配");
      }
      this.sessions.set(sessionId, session);
      return session;
    }).finally(() => {
      if (this.pending.get(sessionId) === creation) this.pending.delete(sessionId);
    });
    this.pending.set(sessionId, creation);
    return creation;
  }

  private handle(sessionId: string, session: T): SessionHandle<T> {
    return {
      session,
      startTurn: () => this.startTurn(sessionId),
      release: () => undefined,
    };
  }

  private ensureCapacity(): void {
    // 正在创建的 Session 同样占用容量，避免不同 ID 的并发单航班绕过上限。
    if (this.sessions.size + this.pending.size < this.maxSessions) return;
    let candidate: string | undefined;
    for (const sessionId of this.sessions.keys()) {
      if (!this.activeTurns.has(sessionId) && !this.retained.has(sessionId)) {
        candidate = sessionId;
        break;
      }
    }
    if (!candidate) throw new DomainError("OPERATION_ABORTED", "活动会话数量已达到运行上限，请关闭空闲连接后重试");
    this.evict(candidate);
  }

  private touch(sessionId: string, session: T): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, session);
  }

  private versionOf(sessionId: string): number {
    return this.versions.get(sessionId) ?? 0;
  }

  private async settlePending(sessionId: string): Promise<void> {
    await this.pending.get(sessionId)?.catch(() => undefined);
  }

  private assertOpenable(sessionId: string): void {
    if (this.disposed || this.invalidated.has(sessionId)) {
      throw new DomainError("SESSION_NOT_FOUND", "Session 不存在");
    }
  }
}
