import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  SessionManager,
  type ToolDefinition,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { dirname, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { rename, rm, unlink } from "node:fs/promises";
import type { StoredProviderConfig } from "./config";
import type { ChatRunStatus, RunCheckpoint, RunCheckpointStore } from "./runtime/checkpoint-store";
import type { SessionMetadataStore } from "./session-metadata";
import { EventJournal } from "./runtime/event-journal";
import { SYSTEM_LIMITS } from "./core/limits";
import { SessionRegistry } from "./runtime/session-registry";
import { CheckpointWriter } from "./runtime/checkpoint-writer";
import { DomainError, toSafePublicMessage } from "./core/errors";
import { KeyedMutex } from "./core/keyed-mutex";
import { createAgentSystemPromptInjectionExtension } from "./agent-system-prompt-extension";
import type { EffectiveRetrievalCapabilities } from "./agent-retrieval-capabilities";
import type { AgentProfile, TitleGenerationConfig } from "../shared/agent-contracts";

/**
 * 复用 Pi 默认资源发现能力，并注册系统提示词注入扩展。
 */
export function createWorkspaceResourceLoader(
  cwd: string,
  agentDir: string,
  additionalPrompts: string[] = [],
  currentAdditionalPrompts?: () => string[],
  retrievalCapabilities: EffectiveRetrievalCapabilities = {
    knowledgeSearch: false,
    knowledgeRead: false,
    webSearch: false,
    webRead: false,
  },
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [createAgentSystemPromptInjectionExtension(retrievalCapabilities)],
    // 显式指定源，保持 Web 原有行为：不意外读取工作目录里的 APPEND_SYSTEM.md。
    appendSystemPrompt: currentAdditionalPrompts ? [] : additionalPrompts,
    // 提示词文件可在会话存活期间更新，reload 时从闭包读取最新快照。
    ...(currentAdditionalPrompts
      ? { appendSystemPromptOverride: () => currentAdditionalPrompts() }
      : {}),
  });
}

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
}

type ThinkingLevel = NonNullable<AgentProfile["defaultThinkingLevel"]>;

/**
 * 标题请求使用的已解析模型与统一思考参数。
 */
export interface TitleGenerationRequest {
  model: unknown;
  reasoning: ThinkingLevel;
}

/**
 * 读取 Pi 全局范围的默认模型，不采纳 Agent 工作目录的项目设置覆盖。
 *
 * @param settingsManager Pi 设置管理器
 */
export function getGlobalDefaultModel(settingsManager: { getGlobalSettings(): { defaultProvider?: unknown; defaultModel?: unknown } }): { provider: string; id: string } | undefined {
  const settings = settingsManager.getGlobalSettings();
  if (typeof settings.defaultProvider !== "string" || typeof settings.defaultModel !== "string") return undefined;
  if (!settings.defaultProvider.trim() || !settings.defaultModel.trim()) return undefined;
  return { provider: settings.defaultProvider, id: settings.defaultModel };
}

/**
 * 根据 Agent 标题策略解析本次会话应使用的模型和思考等级。
 *
 * @param sessionModel 会话当前实际模型
 * @param titleGeneration Agent 标题生成策略
 * @param defaultThinkingLevel Agent 思考级别
 * @param systemDefaultModel Pi 全局默认模型
 * @param findModel 从当前运行时获取可用模型
 */
export function resolveTitleGenerationRequest(
  sessionModel: unknown,
  titleGeneration: TitleGenerationConfig | undefined,
  defaultThinkingLevel: AgentProfile["defaultThinkingLevel"] | undefined,
  systemDefaultModel: { provider: string; id: string } | undefined,
  findModel: (provider: string, modelId: string) => unknown,
): TitleGenerationRequest | undefined {
  const modelSource = titleGeneration?.modelSource ?? "session";
  const selection = modelSource === "custom"
    ? titleGeneration?.model
    : modelSource === "system-default"
      ? systemDefaultModel
      : undefined;
  const model = modelSource === "session"
    ? sessionModel
    : selection ? findModel(selection.provider, selection.id) : undefined;
  if (!model) return undefined;
  const requestedThinking = titleGeneration?.thinkingEnabled ? defaultThinkingLevel ?? "medium" : "off";
  return { model, reasoning: supportsReasoning(model) ? requestedThinking : "off" };
}

/**
 * 判断 Pi 模型是否声明支持统一思考参数。
 *
 * @param model Pi 运行时模型
 */
function supportsReasoning(model: unknown): boolean {
  return typeof model === "object" && model !== null && (model as { reasoning?: unknown }).reasoning === true;
}

/** SDK 在当前 Agent 上实际可执行的斜杠命令安全摘要。 */
export interface PiCommandSummary {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
}

export interface SessionSummary {
  id: string;
  path: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

export interface SessionSnapshot {
  id: string;
  messages: unknown[];
  model?: ModelSummary;
  run?: ChatRunSummary;
  lastEventId: number;
}

export interface ChatRunSummary {
  runId: string;
  sessionId: string;
  status: ChatRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

interface ChatEventBase {
  id: number;
  sessionId: string;
  runId?: string;
}

export type ChatEvent = ChatEventBase & (
  | { type: "snapshot"; messages: unknown[]; model?: ModelSummary; run?: ChatRunSummary; lastEventId: number }
  | { type: "projection_required"; lastEventId: number }
  | { type: "model_changed"; model: ModelSummary }
  | { type: "run_started"; run: ChatRunSummary }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_finished" }
  | { type: "session_renamed"; name: string }
  | { type: "tool_started"; callId: string; toolName: string; args: unknown }
  | { type: "tool_updated"; callId: string; toolName: string; partialResult: unknown }
  | { type: "tool_finished"; callId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "completed" }
  | { type: "aborted" }
  | { type: "error"; code: "AGENT_EXECUTION_FAILED"; message: string }
);

type UnsequencedChatEvent =
  | { type: "snapshot"; messages: unknown[]; model?: ModelSummary; run?: ChatRunSummary; lastEventId: number }
  | { type: "model_changed"; model: ModelSummary }
  | { type: "run_started"; run: ChatRunSummary }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_finished" }
  | { type: "session_renamed"; name: string }
  | { type: "tool_started"; callId: string; toolName: string; args: unknown }
  | { type: "tool_updated"; callId: string; toolName: string; partialResult: unknown }
  | { type: "tool_finished"; callId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "completed" }
  | { type: "aborted" }
  | { type: "error"; code: "AGENT_EXECUTION_FAILED"; message: string };

export interface PiSessionAdapter {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: unknown[];
  readonly streamingMessage?: unknown;
  readonly model: unknown;
  readonly isStreaming: boolean;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  reload(): Promise<void>;
  abort(): Promise<void>;
  setModel(model: unknown): Promise<void>;
  setSessionName(name: string): void;
  /** 跳转 Pi 会话树中的节点，供历史消息编辑和分支切换使用。 */
  navigateTree?(entryId: string): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean }>;
  /** 只读取得指定用户消息，不能改变当前会话叶子。 */
  readMessage?(entryId: string): string | undefined;
  dispose(): void;
}

export interface PiRuntimeBackend {
  listModels(): Promise<ModelSummary[]>;
  listCommands(): Promise<PiCommandSummary[]>;
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<PiSessionAdapter>;
  openSession(sessionId: string): Promise<PiSessionAdapter>;
  findModel(provider: string, modelId: string): unknown;
  generateSessionTitle?(model: unknown, userText: string, assistantText: string): Promise<string | undefined>;
  deleteSession(sessionId: string): Promise<void>;
  stageDeleteSession?(sessionId: string): Promise<StagedSessionDeletion>;
}

export interface StagedSessionDeletion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PiRuntimeGateway {
  listModels(): Promise<ModelSummary[]>;
  listCommands(): Promise<PiCommandSummary[]>;
  listSessions(options?: { archived?: boolean }): Promise<SessionSummary[]>;
  createSession(): Promise<SessionSnapshot>;
  openSession(sessionId: string): Promise<SessionSnapshot>;
  startPrompt(sessionId: string, text: string, userText?: string): Promise<ChatRunSummary>;
  prompt(sessionId: string, text: string): Promise<void>;
  navigateTree?(sessionId: string, entryId: string): Promise<{ snapshot: SessionSnapshot; editorText?: string }>;
  readSessionMessage?(sessionId: string, entryId: string): Promise<string | undefined>;
  abort(sessionId: string): Promise<void>;
  abortAll(): Promise<number>;
  setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  discardUnassignedSession(sessionId: string): Promise<void>;
  prepareSessionDeletion?(sessionId: string): Promise<StagedSessionDeletion>;
  subscribe(
    sessionId: string,
    afterEventIdOrListener: number | undefined | ((event: ChatEvent) => void),
    listener?: (event: ChatEvent) => void,
    onTerminate?: (error: Error) => void,
  ): () => void;
  isBusy?(): boolean;
  onIdle?(listener: () => void): () => void;
  refreshPromptContext?(): Promise<void>;
  /** 刷新或关机前强制持久化尚未落盘的事件投影。 */
  drain?(): Promise<void>;
  dispose(): void;
}

export class PiRuntimeError extends Error {
  constructor(
    readonly code: "SESSION_NOT_FOUND" | "SESSION_BUSY" | "MODEL_NOT_FOUND" | "INVALID_SESSION_NAME",
    message: string,
  ) {
    super(message);
    this.name = "PiRuntimeError";
  }
}

interface ManagedSession {
  session: PiSessionAdapter;
  unsubscribe: () => void;
  dispose(): void;
}

interface ManagedRun extends ChatRunSummary {
  completion: Promise<void>;
  releaseTurn: () => void;
  titleInput?: string;
}

interface PiRuntimeGatewayOptions {
  checkpointStore?: RunCheckpointStore;
  maxEvents?: number;
  maxEventBytes?: number;
  checkpointThrottleMs?: number;
  sessionMetadataStore?: SessionMetadataStore;
  refreshSessionContext?: () => Promise<void>;
  onBackgroundError?: (error: { code: "CHECKPOINT_WRITE_FAILED" | "SESSION_TITLE_GENERATION_FAILED"; sessionId?: string }) => void;
  onSessionTitleGenerated?: (event: { sessionId: string; elapsedMs: number; status: "renamed" | "empty" | "skipped" | "failed" }) => void;
}

/**
 * 将 pi SDK 会话包装成适合 HTTP/SSE 使用的并发安全网关。
 */
export function createPiRuntimeGateway(backend: PiRuntimeBackend, options: PiRuntimeGatewayOptions = {}): PiRuntimeGateway {
  const listeners = new Map<string, Set<(event: ChatEvent) => void>>();
  const subscriptionTerminators = new Map<string, Set<(error: Error) => void>>();
  const runs = new Map<string, ManagedRun>();
  const eventLogs = new Map<string, EventJournal<ChatEvent>>();
  const recoveredCheckpoints = new Map<string, RunCheckpoint>();
  const pendingSessionSummaries = new Map<string, SessionSummary>();
  const abortRequested = new Set<string>();
  const idleListeners = new Set<() => void>();
  const pendingPromptReloads = new Set<string>();
  const deletingSessions = new Set<string>();
  const manuallyRenamedSessions = new Set<string>();
  const backgroundTitleTasks = new Set<Promise<void>>();
  const sessionIdleWaiters = new Map<string, Set<() => void>>();
  let disposed = false;
  const sessionMutations = new KeyedMutex();
  const maxEvents = options.maxEvents ?? SYSTEM_LIMITS.eventJournalEntries;
  const maxEventBytes = options.maxEventBytes ?? SYSTEM_LIMITS.eventJournalBytes;
  const sessionMetadataStore = options.sessionMetadataStore ?? createMemorySessionMetadataStore();
  const checkpointWriter = new CheckpointWriter<{ sessionId: string; version: number; checkpoint: RunCheckpoint }>({
    write: async ({ checkpoint }) => options.checkpointStore?.save(checkpoint),
    debounceMs: options.checkpointThrottleMs ?? 1_000,
    maxDelayMs: 5_000,
    onError: () => options.onBackgroundError?.({ code: "CHECKPOINT_WRITE_FAILED" }),
  });
  const sessionRegistry = new SessionRegistry<ManagedSession>({
    open: async (sessionId) => manageSession(await backend.openSession(sessionId)),
    idOf: (managed) => managed.session.sessionId,
    onRemove: (sessionId) => {
      listeners.delete(sessionId);
      eventLogs.delete(sessionId);
      recoveredCheckpoints.delete(sessionId);
      pendingPromptReloads.delete(sessionId);
    },
  });

  function publish(event: ChatEvent): void {
    listeners.get(event.sessionId)?.forEach((listener) => listener(event));
  }

  function eventLog(sessionId: string): EventJournal<ChatEvent> {
    const existing = eventLogs.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new EventJournal<ChatEvent>({ maxEntries: maxEvents, maxBytes: maxEventBytes });
    eventLogs.set(sessionId, created);
    return created;
  }

  function publishSequenced(
    sessionId: string,
    event: UnsequencedChatEvent,
    options: { associateCurrentRun?: boolean } = {},
  ): ChatEvent {
    const journal = eventLog(sessionId);
    const runId = options.associateCurrentRun === false ? undefined : runs.get(sessionId)?.runId;
    const fits = (candidate: UnsequencedChatEvent) => serializedBytes({
      ...candidate,
      sessionId,
      ...(runId ? { runId } : {}),
      id: journal.latestId + 1,
    }) <= SYSTEM_LIMITS.realtimeEventBytes;
    const bounded = boundRealtimeEvent(event, fits);
    const sequenced = journal.append({ ...bounded, sessionId, ...(runId ? { runId } : {}) } as Omit<ChatEvent, "id">);
    publish(sequenced);
    scheduleCheckpoint(sessionId);
    return sequenced;
  }

  function attachSession(session: PiSessionAdapter): SessionSnapshot {
    const existing = sessionRegistry.peek(session.sessionId);
    if (!existing) {
      sessionRegistry.attach(manageSession(session));
    } else if (existing.session !== session) {
      session.dispose();
    }
    const attached = sessionRegistry.peek(session.sessionId)!.session;
    return snapshotSession(
      attached,
      snapshotMessages(session.sessionId, attached),
      runs.get(session.sessionId) ?? checkpointRun(recoveredCheckpoints.get(session.sessionId)),
      lastEventId(session.sessionId),
    );
  }

  function manageSession(session: PiSessionAdapter): ManagedSession {
    const unsubscribe = session.subscribe((event) => {
      const normalized = normalizeSessionEvent(session.sessionId, event);
      if (normalized) publishSequenced(session.sessionId, normalized);
    });
    return {
      session,
      unsubscribe,
      dispose() {
        unsubscribe();
        session.dispose();
      },
    };
  }

  function requireSession(sessionId: string): PiSessionAdapter {
    if (deletingSessions.has(sessionId)) {
      throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
    }
    const managed = sessionRegistry.peek(sessionId);
    if (!managed) {
      throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
    }
    return managed.session;
  }

  function requireIdleSession(sessionId: string): void {
    const session = sessionRegistry.peek(sessionId)?.session;
    if (runs.has(sessionId) || session?.isStreaming) {
      throw new PiRuntimeError("SESSION_BUSY", "会话正在生成中");
    }
  }

  async function ensureSessionExists(sessionId: string): Promise<void> {
    if ((await backend.listSessions()).some((session) => session.id === sessionId)) {
      return;
    }
    throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
  }

  function lastEventId(sessionId: string): number {
    return eventLog(sessionId).latestId;
  }

  function currentRunSummary(sessionId: string): ChatRunSummary | undefined {
    const run = runs.get(sessionId);
    return run ? toRunSummary(run) : checkpointRun(recoveredCheckpoints.get(sessionId));
  }

  function snapshotMessages(sessionId: string, session: PiSessionAdapter): unknown[] {
    // Pi Session JSONL 是消息历史的唯一事实源；检查点只恢复活动 Run 元数据。
    return liveSessionMessages(session);
  }

  /**
   * 在生成结束后推送权威快照，使浏览器立即获得 Pi 写入后的稳定节点 ID。
   *
   * 快照的游标预先指向即将写入 Journal 的事件 ID，避免客户端重复消费该快照。
   */
  function publishSessionSnapshot(sessionId: string, session: PiSessionAdapter, run?: ChatRunSummary): void {
    const nextEventId = lastEventId(sessionId) + 1;
    publishSequenced(sessionId, {
      type: "snapshot",
      messages: snapshotMessages(sessionId, session),
      model: toModelSummary(session.model),
      run,
      lastEventId: nextEventId,
    });
  }

  function checkpointProjection(sessionId: string): { sessionId: string; version: number; checkpoint: RunCheckpoint } | undefined {
    if (!options.checkpointStore) {
      return undefined;
    }
    const session = sessionRegistry.peek(sessionId)?.session;
    const run = currentRunSummary(sessionId);
    if (!session) {
      return undefined;
    }
    const checkpoint: RunCheckpoint = {
      version: 1,
      ...(run ?? {}),
      sessionId,
      lastEventId: lastEventId(sessionId),
    };
    recoveredCheckpoints.set(sessionId, checkpoint);
    return { sessionId, version: checkpoint.lastEventId, checkpoint };
  }

  async function persistCheckpoint(sessionId: string): Promise<void> {
    const projection = checkpointProjection(sessionId);
    if (!projection) return;
    checkpointWriter.schedule(projection);
    await checkpointWriter.flush();
  }

  function scheduleCheckpoint(sessionId: string): void {
    const projection = checkpointProjection(sessionId);
    if (projection) checkpointWriter.schedule(projection);
  }

  function beginRun(sessionId: string, text: string, titleInput?: string): ManagedRun {
    const session = requireSession(sessionId);
    if (runs.has(sessionId) || session.isStreaming) {
      throw new PiRuntimeError("SESSION_BUSY", "会话正在生成中");
    }
    const releaseTurn = sessionRegistry.startTurn(sessionId);
    const run = {
      runId: randomUUID(),
      sessionId,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      completion: Promise.resolve(),
      releaseTurn,
      ...(session.messages.length === 0 && titleInput?.trim() ? { titleInput: titleInput.trim() } : {}),
    };
    runs.set(sessionId, run);
    recoveredCheckpoints.delete(sessionId);
    publishSequenced(sessionId, { type: "run_started", run: toRunSummary(run) });
    run.completion = executeRun(run, session, text);
    void Promise.resolve().then(() => {
      // Pi 已在 prompt 启动阶段写入用户节点后，立即把稳定节点 ID 同步给在线客户端。
      if (runs.get(sessionId) === run && run.status === "running") {
        publishSessionSnapshot(sessionId, session, toRunSummary(run));
      }
    });
    return run;
  }

  /** 在会话空闲时应用已更新的提示词文件；生成中的会话留待本轮结束。 */
  async function reloadPromptContextForSession(sessionId: string): Promise<void> {
    const managed = sessionRegistry.peek(sessionId);
    if (!managed) return;
    if (runs.has(sessionId) || managed.session.isStreaming) {
      pendingPromptReloads.add(sessionId);
      return;
    }
    pendingPromptReloads.delete(sessionId);
    await managed.session.reload();
  }

  /** 仅在此前有写入操作时，在下一轮开始前补做重载。 */
  function reloadPendingPromptContext(sessionId: string): Promise<void> | undefined {
    if (!pendingPromptReloads.has(sessionId)) return undefined;
    return reloadPromptContextForSession(sessionId);
  }

  /** 读取最新提示词快照，并刷新所有已打开的会话。 */
  async function refreshPromptContext(): Promise<void> {
    await options.refreshSessionContext?.();
    await Promise.all(sessionRegistry.ids().map((sessionId) => reloadPromptContextForSession(sessionId)));
  }

  /** 在当前会话的活动 Run 结束后唤醒等待中的后台附属任务。 */
  function notifySessionIdle(sessionId: string): void {
    const waiters = sessionIdleWaiters.get(sessionId);
    sessionIdleWaiters.delete(sessionId);
    waiters?.forEach((resolve) => resolve());
  }

  /** 等待会话停止流式输出，避免后台任务与新的 Run 并发写入 Pi 会话文件。 */
  function waitForSessionIdle(sessionId: string, session: PiSessionAdapter): Promise<void> {
    if (!runs.has(sessionId) && !session.isStreaming) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = sessionIdleWaiters.get(sessionId) ?? new Set<() => void>();
      waiters.add(resolve);
      sessionIdleWaiters.set(sessionId, waiters);
    });
  }

  /**
   * 在主 Run 已完成后生成首轮标题，避免附属模型请求阻塞对话完成事件。
   */
  function scheduleSessionTitle(run: ManagedRun, session: PiSessionAdapter): void {
    if (!run.titleInput || !backend.generateSessionTitle) return;
    const sessionId = run.sessionId;
    const userText = run.titleInput;
    const assistantText = extractAssistantText(session.messages);
    const model = session.model;
    const startedAt = Date.now();
    let status: "renamed" | "empty" | "skipped" | "failed" = "empty";
    const task = Promise.resolve()
      .then(async () => {
        const title = await backend.generateSessionTitle!(model, userText, assistantText);
        const sessionName = normalizeGeneratedSessionName(title);
        if (!sessionName || !isValidSessionName(sessionName)) return;
        while (!disposed && !deletingSessions.has(sessionId) && !manuallyRenamedSessions.has(sessionId)) {
          await waitForSessionIdle(sessionId, session);
          const applied = await sessionMutations.run(sessionId, async () => {
            if (runs.has(sessionId) || session.isStreaming) return false;
            if (disposed || deletingSessions.has(sessionId) || manuallyRenamedSessions.has(sessionId)) return false;
            session.setSessionName(sessionName);
            publishSequenced(sessionId, { type: "session_renamed", name: sessionName }, { associateCurrentRun: false });
            return true;
          });
          if (applied) {
            status = "renamed";
            return;
          }
        }
        status = "skipped";
      })
      .catch(() => {
        if (disposed) {
          status = "skipped";
          return;
        }
        status = "failed";
        options.onBackgroundError?.({ code: "SESSION_TITLE_GENERATION_FAILED", sessionId });
      })
      .finally(() => {
        backgroundTitleTasks.delete(task);
        if (!disposed) {
          options.onSessionTitleGenerated?.({ sessionId, elapsedMs: Date.now() - startedAt, status });
        }
      });
    backgroundTitleTasks.add(task);
  }

  async function executeRun(run: ManagedRun, session: PiSessionAdapter, text: string): Promise<void> {
    try {
      await session.prompt(text);
      run.status = abortRequested.has(run.sessionId) ? "aborted" : "completed";
      run.finishedAt = new Date().toISOString();
      if (run.status === "completed") {
        publishSessionSnapshot(run.sessionId, session, toRunSummary(run));
      }
      publishSequenced(run.sessionId, { type: run.status });
      if (run.status === "completed") {
        scheduleSessionTitle(run, session);
      }
    } catch (error) {
      if (abortRequested.has(run.sessionId)) {
        run.status = "aborted";
        run.finishedAt = new Date().toISOString();
        publishSequenced(run.sessionId, { type: "aborted" });
        return;
      }
      run.status = "error";
      run.error = toSafePublicMessage(error, "Agent 执行失败");
      run.finishedAt = new Date().toISOString();
      publishSequenced(run.sessionId, { type: "error", code: "AGENT_EXECUTION_FAILED", message: run.error });
    } finally {
      abortRequested.delete(run.sessionId);
      run.releaseTurn();
      await persistCheckpoint(run.sessionId).catch(() => {
        options.onBackgroundError?.({ code: "CHECKPOINT_WRITE_FAILED", sessionId: run.sessionId });
      });
      runs.delete(run.sessionId);
      notifySessionIdle(run.sessionId);
      if (pendingPromptReloads.has(run.sessionId)) {
        await reloadPromptContextForSession(run.sessionId).catch(() => undefined);
      }
      if (runs.size === 0) {
        idleListeners.forEach((listener) => listener());
      }
    }
  }

  /**
   * 请求中断指定会话的活动生成；单会话与批量中断复用这一逻辑。
   */
  async function abortSession(sessionId: string): Promise<void> {
    await sessionMutations.run(sessionId, async () => {
      const session = requireSession(sessionId);
      if (!runs.has(sessionId) && !session.isStreaming) {
        return;
      }
      abortRequested.add(sessionId);
      await session.abort();
    });
  }

  let checkpointDrain: Promise<void> | undefined;
  const drainCheckpoints = () => {
    checkpointDrain ??= checkpointWriter.dispose().catch((error) => {
      options.onBackgroundError?.({ code: "CHECKPOINT_WRITE_FAILED" });
      throw error;
    });
    return checkpointDrain;
  };

  return {
    listModels: () => backend.listModels(),
    listCommands: () => backend.listCommands(),
    async listSessions(listOptions = {}) {
      const archivedIds = new Set(await sessionMetadataStore.listArchivedIds());
      const archived = listOptions.archived ?? false;
      const persisted = await backend.listSessions();
      const persistedIds = new Set(persisted.map((session) => session.id));
      persistedIds.forEach((sessionId) => pendingSessionSummaries.delete(sessionId));
      return [...persisted, ...pendingSessionSummaries.values()]
        .filter((session) => archivedIds.has(session.id) === archived)
        .sort((left, right) => right.modified.localeCompare(left.modified));
    },

    async createSession() {
      const created = await backend.createSession();
      const now = new Date().toISOString();
      pendingSessionSummaries.set(created.sessionId, {
        id: created.sessionId,
        path: created.sessionFile ?? "",
        created: now,
        modified: now,
        messageCount: 0,
        firstMessage: "新对话",
      });
      return attachSession(created);
    },

    async openSession(sessionId) {
      if (deletingSessions.has(sessionId)) throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
      const existing = sessionRegistry.peek(sessionId);
      if (!recoveredCheckpoints.has(sessionId) && options.checkpointStore) {
        const checkpoint = await options.checkpointStore.load(sessionId);
        if (checkpoint) {
          recoveredCheckpoints.set(sessionId, checkpoint);
          eventLog(sessionId).restoreLatestId(checkpoint.lastEventId);
        }
      }
      if (existing) {
        return snapshotSession(existing.session, snapshotMessages(sessionId, existing.session), currentRunSummary(sessionId), lastEventId(sessionId));
      }
      const handle = await sessionRegistry.open(sessionId);
      try {
        return snapshotSession(handle.session.session, snapshotMessages(sessionId, handle.session.session), currentRunSummary(sessionId), lastEventId(sessionId));
      } finally {
        handle.release();
      }
    },

    async startPrompt(sessionId, text, userText) {
      const run = await sessionMutations.run(sessionId, async () => {
        const pendingReload = reloadPendingPromptContext(sessionId);
        if (pendingReload) await pendingReload;
        const summary = pendingSessionSummaries.get(sessionId);
        if (summary) {
          pendingSessionSummaries.set(sessionId, {
            ...summary,
            modified: new Date().toISOString(),
            messageCount: Math.max(1, summary.messageCount),
            firstMessage: summary.messageCount === 0 ? summarizePendingPrompt(text) : summary.firstMessage,
          });
        }
        return beginRun(sessionId, text, userText);
      });
      return toRunSummary(run);
    },

    async prompt(sessionId, text) {
      const run = await sessionMutations.run(sessionId, async () => {
        const pendingReload = reloadPendingPromptContext(sessionId);
        if (pendingReload) await pendingReload;
        return beginRun(sessionId, text);
      });
      await run.completion;
    },
    async navigateTree(sessionId, entryId) {
      const session = requireSession(sessionId);
      requireIdleSession(sessionId);
      if (!session.navigateTree) {
        throw new PiRuntimeError("SESSION_NOT_FOUND", "当前 Pi 会话不支持分支导航");
      }
      const result = await session.navigateTree(entryId);
      if (result.cancelled || result.aborted) {
        throw new PiRuntimeError("SESSION_NOT_FOUND", "会话分支切换失败");
      }
      return {
        snapshot: snapshotSession(session, snapshotMessages(sessionId, session), undefined, lastEventId(sessionId)),
        editorText: result.editorText,
      };
    },
    async readSessionMessage(sessionId, entryId) {
      const session = requireSession(sessionId);
      return session.readMessage?.(entryId);
    },

    abort: (sessionId) => abortSession(sessionId),

    async abortAll() {
      const results = await Promise.allSettled([...runs.keys()].map((sessionId) => abortSession(sessionId)));
      return results.filter((result) => result.status === "fulfilled").length;
    },

    async setModel(sessionId, provider, modelId) {
      await sessionMutations.run(sessionId, async () => {
        const session = requireSession(sessionId);
        if (runs.has(sessionId) || session.isStreaming) {
          throw new PiRuntimeError("SESSION_BUSY", "会话正在生成中");
        }
        const model = backend.findModel(provider, modelId);
        if (!model) {
          throw new PiRuntimeError("MODEL_NOT_FOUND", "模型不存在或不可用");
        }
        await session.setModel(model);
        const summary = toModelSummary(model);
        if (!summary) throw new PiRuntimeError("MODEL_NOT_FOUND", "模型信息无效");
        publishSequenced(sessionId, { type: "model_changed", model: summary });
      });
    },

    async renameSession(sessionId, name) {
      const sanitized = name.replace(/[\r\n]+/g, " ").trim();
      if (!sanitized || [...sanitized].length > 120) {
        throw new PiRuntimeError("INVALID_SESSION_NAME", "会话名称不能为空且不能超过 120 个字符");
      }
      await sessionMutations.run(sessionId, async () => {
        requireIdleSession(sessionId);
        const managed = sessionRegistry.peek(sessionId);
        let session = managed?.session;
        if (!session) {
          const handle = await sessionRegistry.open(sessionId);
          session = handle.session.session;
          handle.release();
        }
        session.setSessionName(sanitized);
        manuallyRenamedSessions.add(sessionId);
        const summary = pendingSessionSummaries.get(sessionId);
        if (summary) pendingSessionSummaries.set(sessionId, { ...summary, name: sanitized });
      });
    },

    async archiveSession(sessionId) {
      await sessionMutations.run(sessionId, async () => {
        requireIdleSession(sessionId);
        await ensureSessionExists(sessionId);
        await sessionMetadataStore.archive(sessionId);
      });
    },

    async unarchiveSession(sessionId) {
      await sessionMutations.run(sessionId, async () => {
        await ensureSessionExists(sessionId);
        await sessionMetadataStore.unarchive(sessionId);
      });
    },

    async prepareSessionDeletion(sessionId) {
      return sessionMutations.run(sessionId, async () => {
        if (deletingSessions.has(sessionId)) throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
        requireIdleSession(sessionId);
        await ensureSessionExists(sessionId);
        deletingSessions.add(sessionId);
        let staged: StagedSessionDeletion;
        try {
          staged = backend.stageDeleteSession
            ? await backend.stageDeleteSession(sessionId)
            : { commit: () => backend.deleteSession(sessionId), rollback: async () => undefined };
        } catch (error) {
          deletingSessions.delete(sessionId);
          throw error;
        }
        sessionRegistry.invalidate(sessionId);
        subscriptionTerminators.get(sessionId)?.forEach((terminate) => terminate(
          new DomainError("SESSION_NOT_FOUND", "Session 已删除，实时连接需要关闭"),
        ));
        subscriptionTerminators.delete(sessionId);
        listeners.delete(sessionId);
        eventLogs.delete(sessionId);
        recoveredCheckpoints.delete(sessionId);
        pendingSessionSummaries.delete(sessionId);
        let completed = false;
        return {
          async commit() {
            if (completed) return;
            try {
              await staged.commit();
              await options.checkpointStore?.remove(sessionId).catch(() => undefined);
            } finally {
              completed = true;
              deletingSessions.delete(sessionId);
              await sessionRegistry.finalizeDeletion(sessionId);
            }
          },
          async rollback() {
            if (completed) return;
            await staged.rollback();
            completed = true;
            deletingSessions.delete(sessionId);
            await sessionRegistry.restore(sessionId);
          },
        };
      });
    },

    async deleteSession(sessionId) {
      const staged = await this.prepareSessionDeletion!(sessionId);
      try {
        await sessionMetadataStore.remove(sessionId);
      } catch (error) {
        await staged.rollback();
        throw error;
      }
      await staged.commit();
    },

    async discardUnassignedSession(sessionId) {
      // 新建空 Session 在首条消息前可能还没有 JSONL，不能复用依赖 listSessions 的正常删除路径。
      await sessionMutations.run(sessionId, async () => {
        const staged = (await backend.listSessions()).some((session) => session.id === sessionId)
          ? await backend.stageDeleteSession?.(sessionId)
          : undefined;
        sessionRegistry.invalidate(sessionId);
        subscriptionTerminators.get(sessionId)?.forEach((terminate) => terminate(new DomainError("SESSION_NOT_FOUND", "Session 创建已回滚")));
        subscriptionTerminators.delete(sessionId);
        listeners.delete(sessionId);
        eventLogs.delete(sessionId);
        recoveredCheckpoints.delete(sessionId);
        pendingSessionSummaries.delete(sessionId);
        try {
          await staged?.commit();
          await options.checkpointStore?.remove(sessionId).catch(() => undefined);
        } finally {
          await sessionRegistry.finalizeDeletion(sessionId);
        }
      });
    },

    subscribe(sessionId, afterOrListener, maybeListener, onTerminate) {
      const session = requireSession(sessionId);
      const afterEventId = typeof afterOrListener === "number" ? afterOrListener : undefined;
      const listener = typeof afterOrListener === "function" ? afterOrListener : maybeListener;
      if (!listener) {
        throw new TypeError("事件监听器不能为空");
      }
      const sessionListeners = listeners.get(sessionId) ?? new Set();
      sessionListeners.add(listener);
      listeners.set(sessionId, sessionListeners);
      if (onTerminate) {
        const terminators = subscriptionTerminators.get(sessionId) ?? new Set();
        terminators.add(onTerminate);
        subscriptionTerminators.set(sessionId, terminators);
      }
      const releaseSession = sessionRegistry.retain(sessionId);
      try {
        const replay = afterEventId === undefined ? undefined : eventLog(sessionId).replay(afterEventId);
        if (replay?.kind === "replay") {
          replay.events.forEach(listener);
        } else if (replay?.kind === "projection_required") {
          listener({
            type: "projection_required",
            id: replay.latestId,
            sessionId,
            lastEventId: replay.latestId,
          });
        } else {
          const snapshot: ChatEvent = {
            type: "snapshot",
            id: lastEventId(sessionId),
            sessionId,
            messages: snapshotMessages(sessionId, session),
            model: toModelSummary(session.model),
            run: currentRunSummary(sessionId),
            lastEventId: lastEventId(sessionId),
          };
          // 长会话快照可能超过 SSE 单事件上限；让客户端改走已有的 HTTP Projection
          // 恢复流程，避免 EventSource 在首连阶段永久重连失败。
          listener(serializedBytes(snapshot) <= SYSTEM_LIMITS.realtimeEventBytes ? snapshot : {
            type: "projection_required",
            id: snapshot.lastEventId,
            sessionId,
            lastEventId: snapshot.lastEventId,
          });
        }
      } catch (error) {
        sessionListeners.delete(listener);
        releaseSession();
        throw error;
      }
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        sessionListeners.delete(listener);
        if (sessionListeners.size === 0) {
          listeners.delete(sessionId);
        }
        if (onTerminate) {
          const terminators = subscriptionTerminators.get(sessionId);
          terminators?.delete(onTerminate);
          if (terminators?.size === 0) subscriptionTerminators.delete(sessionId);
        }
        releaseSession();
      };
    },

    isBusy() {
      return runs.size > 0;
    },

    onIdle(listener) {
      idleListeners.add(listener);
      return () => idleListeners.delete(listener);
    },

    refreshPromptContext,

    drain: drainCheckpoints,

    dispose() {
      disposed = true;
      sessionRegistry.dispose();
      listeners.clear();
      subscriptionTerminators.clear();
      runs.clear();
      eventLogs.clear();
      pendingSessionSummaries.clear();
      abortRequested.clear();
      pendingPromptReloads.clear();
      deletingSessions.clear();
      manuallyRenamedSessions.clear();
      backgroundTitleTasks.clear();
      sessionIdleWaiters.forEach((waiters) => waiters.forEach((resolve) => resolve()));
      sessionIdleWaiters.clear();
      // 兼容直接调用 dispose 的旧调用方；Supervisor 会先显式 await drain。
      void drainCheckpoints().catch(() => undefined);
      idleListeners.clear();
    },
  };
}

interface SdkPiRuntimeOptions {
  cwd: string;
  agentDir: string;
  provider?: StoredProviderConfig;
  modelRuntime?: ModelRuntime;
  defaultModel?: { provider: string; id: string };
  defaultThinkingLevel?: AgentProfile["defaultThinkingLevel"];
  titleGeneration?: TitleGenerationConfig;
  allowedTools?: string[];
  customTools?: ToolDefinition[];
  retrievalCapabilities: EffectiveRetrievalCapabilities;
  appendSystemPrompt?: string[];
  refreshAppendSystemPrompt?: () => Promise<string[]>;
  sessionDir?: string;
  checkpointStore?: RunCheckpointStore;
  sessionMetadataStore?: SessionMetadataStore;
  onBackgroundError?: (error: { code: "CHECKPOINT_WRITE_FAILED" | "SESSION_TITLE_GENERATION_FAILED"; sessionId?: string }) => void;
  onSessionTitleGenerated?: (event: { sessionId: string; elapsedMs: number; status: "renamed" | "empty" | "skipped" | "failed" }) => void;
  stageSessionDeletion?: (sessionId: string, sessionFile: string) => Promise<StagedSessionDeletion>;
}

/**
 * 使用固定数据目录创建真实 pi SDK 网关，不修改 pi 上游实现。
 */
export async function createSdkPiRuntimeGateway(options: SdkPiRuntimeOptions): Promise<PiRuntimeGateway> {
  await options.checkpointStore?.markInterrupted();
  const modelRuntime = options.modelRuntime ?? await ModelRuntime.create({
      authPath: join(options.agentDir, "auth.json"),
      modelsPath: join(options.agentDir, "models.json"),
      allowModelNetwork: false,
  });
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const systemDefaultModel = getGlobalDefaultModel(settingsManager);
  const providerId = options.defaultModel?.provider
    ?? (options.provider ? configureProvider(modelRuntime, options.provider) : settingsManager.getDefaultProvider());
  const defaultModel = options.defaultModel?.id ?? options.provider?.defaultModel ?? settingsManager.getDefaultModel();
  if (!providerId || !defaultModel) {
    throw new PiRuntimeError("MODEL_NOT_FOUND", "默认 Provider 或模型尚未配置");
  }
  const selectedProviderId = providerId;
  const selectedDefaultModel = defaultModel;
  if (options.provider) {
    await modelRuntime.setRuntimeApiKey(selectedProviderId, options.provider.apiKey);
  }
  const sessionDir = options.sessionDir ?? join(options.agentDir, "sessions");
  let commandCatalog: PiCommandSummary[] | undefined;
  let appendSystemPrompt = [...(options.appendSystemPrompt ?? [])];

  /** 从 Agent 提示词文件读取下一次 reload 应使用的系统提示片段。 */
  async function refreshAppendSystemPrompt(): Promise<void> {
    if (options.refreshAppendSystemPrompt) {
      appendSystemPrompt = await options.refreshAppendSystemPrompt();
    }
  }

  async function createWithManager(sessionManager: SessionManager): Promise<PiSessionAdapter> {
    const model = modelRuntime.getModel(selectedProviderId, selectedDefaultModel);
    if (!model) {
      throw new PiRuntimeError("MODEL_NOT_FOUND", "默认模型不存在或不可用");
    }
    await refreshAppendSystemPrompt();
    const resourceLoader = createWorkspaceResourceLoader(
      options.cwd,
      options.agentDir,
      appendSystemPrompt,
      () => appendSystemPrompt,
      options.retrievalCapabilities,
    );
    await resourceLoader.reload();
    const { session, extensionsResult } = await createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime,
      model,
      settingsManager,
      sessionManager,
      resourceLoader,
      // Agent 配置必须传入 SDK，避免推理模型回退到 Pi 的 medium 默认值。
      thinkingLevel: options.defaultThinkingLevel ?? "medium",
      // 工具白名单必须与 Agent Profile 一致，不能因为工具已注册就自动放行。
      tools: options.allowedTools ? [...new Set(options.allowedTools)] : undefined,
      customTools: options.customTools,
    });
    commandCatalog ??= extensionsResult.runtime.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
      source: command.source,
    }));
    return adaptAgentSession(session);
  }

  const backend: PiRuntimeBackend = {
    async listModels() {
      const models = await modelRuntime.getAvailable();
      return models.map((model) => ({ provider: model.provider, id: model.id, name: model.name }));
    },
    async listCommands() {
      if (commandCatalog) {
        return commandCatalog;
      }
      const session = await createWithManager(SessionManager.inMemory(options.cwd));
      session.dispose();
      return commandCatalog ?? [];
    },
    async listSessions() {
      const sessionInfos = await SessionManager.list(options.cwd, sessionDir);
      return sessionInfos.map((session) => ({
        id: session.id,
        path: session.path,
        name: session.name,
        created: session.created.toISOString(),
        modified: session.modified.toISOString(),
        messageCount: session.messageCount,
        firstMessage: session.firstMessage,
      }));
    },
    createSession: () => createWithManager(SessionManager.create(options.cwd, sessionDir)),
    async openSession(sessionId) {
      const sessionInfo = (await SessionManager.list(options.cwd, sessionDir)).find((session) => session.id === sessionId);
      if (!sessionInfo) {
        throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
      }
      return createWithManager(SessionManager.open(sessionInfo.path, sessionDir, options.cwd));
    },
    findModel: (provider, modelId) => modelRuntime.getModel(provider, modelId),
    async generateSessionTitle(model, userText, assistantText) {
      if (!assistantText.trim()) return undefined;
      const titleRequest = resolveTitleGenerationRequest(
        model,
        options.titleGeneration,
        options.defaultThinkingLevel,
        systemDefaultModel,
        (provider, modelId) => modelRuntime.getModel(provider, modelId),
      );
      if (!titleRequest) return undefined;
      const response = await modelRuntime.completeSimple(titleRequest.model as never, {
        messages: [{ role: "user", content: `请根据以下用户问题和回答生成一个简洁的中文会话标题。只输出标题，不要解释、引号或 Markdown。\n\n用户问题：${userText}\n\n回答：${assistantText}`, timestamp: Date.now() }],
      }, { reasoning: titleRequest.reasoning, maxRetries: 0, timeoutMs: 15_000 } as never);
      if (response.stopReason === "error" || response.stopReason === "aborted") {
        // 标题模型失败由网关统一记录，不向客户端暴露上游错误详情。
        throw new Error("会话标题生成失败");
      }
      const text = response.content.find((item) => item.type === "text");
      return text?.type === "text" ? text.text.replace(/[\r\n]+/g, " ").trim() : undefined;
    },
    async deleteSession(sessionId) {
      const sessionInfo = (await SessionManager.list(options.cwd, sessionDir)).find((session) => session.id === sessionId);
      if (!sessionInfo) {
        throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
      }
      const resolvedFile = assertManagedSessionFile(sessionDir, sessionInfo.path);
      await unlink(resolvedFile);
    },
    async stageDeleteSession(sessionId) {
      const sessionInfo = (await SessionManager.list(options.cwd, sessionDir)).find((session) => session.id === sessionId);
      if (!sessionInfo) throw new PiRuntimeError("SESSION_NOT_FOUND", "会话不存在");
      const source = assertManagedSessionFile(sessionDir, sessionInfo.path);
      if (options.stageSessionDeletion) return options.stageSessionDeletion(sessionId, source);
      const staged = `${source}.deleting-${randomUUID()}`;
      await rename(source, staged);
      return {
        async commit() { await rm(staged, { force: true }); },
        async rollback() { await rename(staged, source); },
      };
    },
  };

  return createPiRuntimeGateway(backend, {
    checkpointStore: options.checkpointStore,
    sessionMetadataStore: options.sessionMetadataStore,
    refreshSessionContext: refreshAppendSystemPrompt,
    onBackgroundError: options.onBackgroundError,
    onSessionTitleGenerated: options.onSessionTitleGenerated,
  });
}

/**
 * 将删除目标约束到 pi 的精确会话目录，禁止路径穿越和非 JSONL 文件。
 */
export function assertManagedSessionFile(sessionDir: string, filePath: string): string {
  const resolvedFile = resolve(filePath);
  if (dirname(resolvedFile) !== resolve(sessionDir) || extname(resolvedFile) !== ".jsonl") {
    throw new PiRuntimeError("SESSION_NOT_FOUND", "会话文件不在受管目录中");
  }
  return resolvedFile;
}

function adaptAgentSession(session: AgentSession): PiSessionAdapter {
  return {
    get sessionId() {
      return session.sessionId;
    },
    get sessionFile() {
      return session.sessionFile;
    },
    get messages() {
      const branchNavigation = createBranchNavigation(session.sessionManager.getEntries() as unknown[]);
      return session.sessionManager.getBranch().flatMap((entry) => {
        if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return [];
        // 为 Web 端保留 Pi 节点 ID，历史编辑与重新生成必须以该稳定 ID 定位。
        const message = entry.message as unknown as Record<string, unknown>;
        return [{
          ...message,
          __piEntryId: entry.id,
          ...(message.role === "user" && branchNavigation.get(entry.id) ? { __piBranch: branchNavigation.get(entry.id) } : {}),
        }];
      });
    },
    get streamingMessage() {
      return session.state.streamingMessage;
    },
    get model() {
      return session.model;
    },
    get isStreaming() {
      return session.isStreaming;
    },
    subscribe: (listener) => session.subscribe(listener),
    prompt: (text) => session.prompt(text),
    reload: () => session.reload(),
    abort: () => session.abort(),
    setModel: (model) => session.setModel(model as Parameters<AgentSession["setModel"]>[0]),
    setSessionName: (name) => session.setSessionName(name),
    navigateTree: (entryId) => session.navigateTree(entryId, { summarize: false }),
    readMessage: (entryId) => {
      const entry = session.sessionManager.getEntries().find((candidate) => candidate.id === entryId);
      if (entry?.type !== "message" || entry.message.role !== "user") return undefined;
      const content = entry.message.content;
      if (typeof content === "string") return content;
      return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    },
    dispose: () => session.dispose(),
  };
}

/**
 * 根据 Pi 追加式 entry 列表计算同一父节点下用户消息的版本切换信息。
 */
function createBranchNavigation(entries: unknown[]): Map<string, { index: number; count: number; previousEntryId?: string; nextEntryId?: string; previousNavigationEntryId?: string; nextNavigationEntryId?: string }> {
  const records = entries.flatMap((entry, index) => isRecord(entry) && typeof entry.id === "string"
    ? [{ id: entry.id, parentId: typeof entry.parentId === "string" ? entry.parentId : undefined, index, entry }]
    : []);
  const children = new Map<string, string[]>();
  const positions = new Map(records.map((record) => [record.id, record.index]));
  records.forEach((record) => {
    if (!record.parentId) return;
    const siblings = children.get(record.parentId) ?? [];
    siblings.push(record.id);
    children.set(record.parentId, siblings);
  });
  const latestLeaf = (entryId: string): string => {
    const descendants = children.get(entryId) ?? [];
    if (descendants.length === 0) return entryId;
    return descendants
      .map((childId) => latestLeaf(childId))
      .reduce((latest, candidate) => (positions.get(candidate)! > positions.get(latest)! ? candidate : latest));
  };
  const groups = new Map<string, Array<{ id: string; navigationEntryId: string }>>();
  for (const record of records) {
    const entry = record.entry;
    if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
    const parentId = record.parentId ?? "__root__";
    const group = groups.get(parentId) ?? [];
    group.push({ id: record.id, navigationEntryId: latestLeaf(record.id) });
    groups.set(parentId, group);
  }
  const result = new Map<string, { index: number; count: number; previousEntryId?: string; nextEntryId?: string; previousNavigationEntryId?: string; nextNavigationEntryId?: string }>();
  for (const group of groups.values()) {
    group.forEach((entry, index) => result.set(entry.id, {
      index,
      count: group.length,
      ...(group[index - 1] ? { previousEntryId: group[index - 1].id } : {}),
      ...(group[index + 1] ? { nextEntryId: group[index + 1].id } : {}),
      ...(group[index - 1] ? { previousNavigationEntryId: group[index - 1].navigationEntryId } : {}),
      ...(group[index + 1] ? { nextNavigationEntryId: group[index + 1].navigationEntryId } : {}),
    }));
  }
  return result;
}

/**
 * 合并 pi 已提交消息与当前未提交的流式 Assistant 消息。
 */
function liveSessionMessages(session: PiSessionAdapter): unknown[] {
  const messages = [...session.messages];
  if (session.streamingMessage !== undefined) {
    messages.push(session.streamingMessage);
  }
  return messages;
}

function configureProvider(modelRuntime: ModelRuntime, provider: StoredProviderConfig): string {
  if (provider.type !== "openai-compatible") {
    return provider.type;
  }

  modelRuntime.registerProvider(provider.type, {
    name: "OpenAI Compatible",
    baseUrl: provider.baseUrl,
    api: "openai-completions",
    models: [
      {
        id: provider.defaultModel,
        name: provider.defaultModel,
        api: "openai-completions",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ],
  });
  return provider.type;
}

function snapshotSession(
  session: PiSessionAdapter,
  messages: unknown[],
  run: ChatRunSummary | undefined,
  lastEventId: number,
): SessionSnapshot {
  return {
    id: session.sessionId,
    messages,
    model: toModelSummary(session.model),
    run,
    lastEventId,
  };
}

function toRunSummary(run: ChatRunSummary): ChatRunSummary {
  return {
    runId: run.runId,
    sessionId: run.sessionId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
  };
}

function checkpointRun(checkpoint: RunCheckpoint | undefined): ChatRunSummary | undefined {
  return checkpoint?.runId && checkpoint.status && checkpoint.startedAt
    ? toRunSummary(checkpoint as ChatRunSummary)
    : undefined;
}

function toModelSummary(value: unknown): ModelSummary | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") {
    return undefined;
  }
  return {
    provider: value.provider,
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
  };
}

function normalizeSessionEvent(
  _sessionId: string,
  event: AgentSessionEvent,
): UnsequencedChatEvent | undefined {
  if (event.type === "message_update") {
    if (event.assistantMessageEvent.type === "text_delta") {
      return { type: "text_delta", delta: event.assistantMessageEvent.delta };
    }
    if (event.assistantMessageEvent.type === "thinking_delta") {
      return { type: "thinking_delta", delta: event.assistantMessageEvent.delta };
    }
    if (event.assistantMessageEvent.type === "thinking_end") {
      return { type: "thinking_finished" };
    }
  }
  if (event.type === "tool_execution_start") {
    return {
      type: "tool_started",
      callId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    };
  }
  if (event.type === "tool_execution_update") {
    return {
      type: "tool_updated",
      callId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    };
  }
  if (event.type === "tool_execution_end") {
    return {
      type: "tool_finished",
      callId: event.toolCallId,
      toolName: event.toolName,
      result: event.result,
      isError: event.isError,
    };
  }
  return undefined;
}

/**
 * 从发送给 pi 的完整 Prompt 中提取用户可见的会话标题。
 */
function summarizePendingPrompt(text: string): string {
  const fileBlockStart = text.indexOf("<pi_agent_files");
  const visibleText = (fileBlockStart >= 0 ? text.slice(0, fileBlockStart) : text).trim();
  return visibleText || "附件";
}

/** 仅提取最终 Assistant 可见文本，避免把思考、工具调用和附件传给标题模型。 */
function extractAssistantText(messages: unknown[]): string {
  const message = [...messages].reverse().find((item) => isRecord(item) && item.role === "assistant");
  const content = isRecord(message) && Array.isArray(message.content) ? message.content : [];
  return content
    .filter((item): item is { type: "text"; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

/** 自动标题与手动会话名称共用相同的持久化长度边界。 */
function isValidSessionName(name: string): boolean {
  return Boolean(name) && [...name].length <= 120;
}

/** 自动标题最多保留五十个字符，避免模型忽略格式要求时占满会话列表。 */
function normalizeGeneratedSessionName(name: string | undefined): string | undefined {
  const normalized = name?.trim();
  return normalized ? [...normalized].slice(0, 50).join("") : undefined;
}

/** 把单个实时事件限制在客户端与 Journal 都能承受的硬上限内。 */
function boundRealtimeEvent(
  event: UnsequencedChatEvent,
  fits: (candidate: UnsequencedChatEvent) => boolean,
): UnsequencedChatEvent {
  if (fits(event)) return event;
  const truncated = { truncated: true, reason: "实时事件载荷超过上限，完整结果保留在会话记录中" };
  let candidate: UnsequencedChatEvent;
  switch (event.type) {
    case "text_delta":
      return fitRealtimeText(event.delta, (delta) => ({ ...event, delta }), fits);
    case "thinking_delta":
      return fitRealtimeText(event.delta, (delta) => ({ ...event, delta }), fits);
    case "error":
      return fitRealtimeText(event.message, (message) => ({ ...event, message }), fits);
    case "tool_started":
      candidate = { ...event, callId: truncateIdentifier(event.callId), toolName: truncateIdentifier(event.toolName), args: truncated };
      break;
    case "tool_updated":
      candidate = { ...event, callId: truncateIdentifier(event.callId), toolName: truncateIdentifier(event.toolName), partialResult: truncated };
      break;
    case "tool_finished":
      candidate = { ...event, callId: truncateIdentifier(event.callId), toolName: truncateIdentifier(event.toolName), result: truncated };
      break;
    default:
      candidate = event;
  }
  if (fits(candidate)) return candidate;
  return { type: "error", code: "AGENT_EXECUTION_FAILED", message: "实时事件载荷超过上限，请打开会话查看完整结果" };
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function fitRealtimeText(
  value: string,
  create: (value: string) => UnsequencedChatEvent,
  fits: (candidate: UnsequencedChatEvent) => boolean,
): UnsequencedChatEvent {
  const characters = Array.from(value);
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(create(characters.slice(0, middle).join("")))) lower = middle;
    else upper = middle - 1;
  }
  return create(characters.slice(0, lower).join(""));
}

function truncateIdentifier(value: string): string {
  return Array.from(value).slice(0, 256).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMemorySessionMetadataStore(): SessionMetadataStore {
  const archived = new Set<string>();
  const agents = new Map<string, string>();
  return {
    getAgentId: async (sessionId) => agents.get(sessionId),
    assignAgent: async (sessionId, agentId) => {
      const existing = agents.get(sessionId);
      if (existing && existing !== agentId) {
        throw new Error("Session 已归属其他 Agent，禁止改绑");
      }
      agents.set(sessionId, agentId);
    },
    isArchived: async (sessionId) => archived.has(sessionId),
    listArchivedIds: async () => [...archived],
    archive: async (sessionId) => { archived.add(sessionId); },
    unarchive: async (sessionId) => { archived.delete(sessionId); },
    remove: async (sessionId) => {
      archived.delete(sessionId);
      agents.delete(sessionId);
    },
    listIdsByAgent: async (agentId) => [...agents.entries()].filter(([, owner]) => owner === agentId).map(([sessionId]) => sessionId),
    removeByAgent: async (agentId) => {
      for (const [sessionId, owner] of agents.entries()) {
        if (owner === agentId) {
          agents.delete(sessionId);
          archived.delete(sessionId);
        }
      }
    },
  };
}
