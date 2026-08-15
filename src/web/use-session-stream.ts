import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatRunSummary } from "../shared/contracts";
import { isProjectionRequiredEvent, isSessionEvent, isSessionSnapshotEvent } from "../shared/api/chat-validation";
import { api, type ModelSummary, type SessionSnapshot } from "./api";
import type { TimelineEvent } from "./conversation-timeline";
import { isSessionHistoryPage } from "../shared/session-history-contracts";
import type { ThinkingLevel } from "../shared/configuration-contracts";
import { PendingQuestionProjectionSchema, type PendingQuestionProjection } from "../shared/session-question-contracts";
import { Check } from "typebox/value";

export interface QuestionResolvedNotice {
  questionRecordId: string;
  state: "submitted" | "discarded";
}

interface SessionStreamOptions {
  sessionId?: string;
  onSnapshot: (snapshot: SessionSnapshot) => void;
  onTimelineEvent: (event: TimelineEvent) => void;
  onRunChange: (run: ChatRunSummary | undefined) => void;
  onModelChange?: (model: ModelSummary) => void;
  onThinkingLevelChange?: (thinkingLevel: ThinkingLevel) => void;
  onPendingQuestion?: (pending: PendingQuestionProjection) => void;
  onQuestionResolved?: (notice: QuestionResolvedNotice) => void;
  onSessionRenamed?: (sessionId: string, name: string) => void;
  onError: (message: string) => void;
  onUnexpectedError?: (error: unknown) => void;
}

export interface SessionStreamControl {
  ensureOpen(): Promise<void>;
  refreshProjection(): void;
  close(): void;
  reconnecting: boolean;
}

interface CallbackSet extends Omit<SessionStreamOptions, "sessionId"> {}

const PROJECTION_RECOVERY_TIMEOUT_MS = 10_000;

/**
 * 统一管理会话 SSE、事件去重和刷新后的运行状态恢复。
 */
export function useSessionStream(options: SessionStreamOptions): SessionStreamControl {
  const sourceRef = useRef<EventSource | undefined>(undefined);
  const lastEventIdRef = useRef(0);
  const callbacksRef = useRef<CallbackSet>(options);
  const pendingDeltasRef = useRef<Array<Extract<TimelineEvent, { type: "text_delta" }>>>([]);
  const refreshProjectionRef = useRef<() => void>(() => undefined);
  const animationFrameRef = useRef<number | undefined>(undefined);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectRequest, setReconnectRequest] = useState<{ sessionId: string; cursor: number; nonce: number }>();

  useEffect(() => {
    callbacksRef.current = options;
  });

  const flushDeltas = useCallback(() => {
    if (animationFrameRef.current !== undefined) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = undefined;
    }
    const pending = pendingDeltasRef.current;
    pendingDeltasRef.current = [];
    pending.forEach((event) => callbacksRef.current.onTimelineEvent(event));
  }, []);

  const enqueueDelta = useCallback((event: Extract<TimelineEvent, { type: "text_delta" }>) => {
    const pending = pendingDeltasRef.current;
    const previous = pending.at(-1);
    if (previous?.type === event.type) {
      previous.delta += event.delta;
    } else {
      pending.push(event);
    }
    if (animationFrameRef.current === undefined) {
      animationFrameRef.current = requestAnimationFrame(() => flushDeltas());
    }
  }, [flushDeltas]);

  const closeTransport = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = undefined;
    lastEventIdRef.current = 0;
    if (animationFrameRef.current !== undefined) cancelAnimationFrame(animationFrameRef.current);
    animationFrameRef.current = undefined;
    pendingDeltasRef.current = [];
    setReconnecting(false);
  }, []);

  const close = useCallback(() => {
    closeTransport();
    setReconnectRequest(undefined);
  }, [closeTransport]);

  useEffect(() => {
    closeTransport();
    if (!options.sessionId) {
      return;
    }

    const cursor = reconnectRequest?.sessionId === options.sessionId ? reconnectRequest.cursor : undefined;
    if (cursor !== undefined) lastEventIdRef.current = cursor;
    const query = cursor === undefined ? "" : `?after=${encodeURIComponent(String(cursor))}`;
    const source = new EventSource(`/api/v1/sessions/${encodeURIComponent(options.sessionId)}/events${query}`);
    sourceRef.current = source;
    let active = true;
    let projectionRecovering = false;
    let recoveryController: AbortController | undefined;
    const recoverProjection = (notice?: string) => {
      if (!active || sourceRef.current !== source || projectionRecovering) return;
      projectionRecovering = true;
      // 游标已接纳的正文必须先交付，避免恢复失败后按新游标重连时丢失动画帧缓冲。
      flushDeltas();
      source.close();
      if (notice) callbacksRef.current.onError(notice);
      recoveryController = new AbortController();
      const recoveryTimeout = window.setTimeout(() => recoveryController?.abort(), PROJECTION_RECOVERY_TIMEOUT_MS);
      void api.openSession(options.sessionId!, recoveryController.signal).then((snapshot) => {
        if (!active || sourceRef.current !== source) return;
        lastEventIdRef.current = snapshot.lastEventId;
        callbacksRef.current.onSnapshot(snapshot);
        setReconnectRequest((current) => ({
          sessionId: options.sessionId!,
          cursor: snapshot.lastEventId,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      }).catch((error: unknown) => {
        if (!active || sourceRef.current !== source) return;
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        if (!cancelled) {
          callbacksRef.current.onUnexpectedError?.(error);
          callbacksRef.current.onError("会话状态恢复失败，正在重新连接。临时中断期间的事件将按游标恢复。");
        }
        setReconnectRequest((current) => ({
          sessionId: options.sessionId!,
          cursor: lastEventIdRef.current,
          nonce: (current?.nonce ?? 0) + 1,
        }));
      }).finally(() => {
        window.clearTimeout(recoveryTimeout);
      });
    };
    refreshProjectionRef.current = recoverProjection;
    const reportInvalidEvent = (
      eventType: string,
      stage: "parse" | "schema" | "identity",
      payload?: Record<string, unknown>,
    ) => {
      if (!active || sourceRef.current !== source || projectionRecovering) return;
      const eventId = typeof payload?.id === "number" && Number.isSafeInteger(payload.id)
        ? payload.id
        : undefined;
      // 诊断只记录协议元数据，禁止输出消息正文、工具参数或完整事件载荷。
      console.warn("会话实时事件校验失败", {
        eventType,
        stage,
        ...(eventId === undefined ? {} : { eventId }),
      });
      recoverProjection("实时事件格式无效，正在恢复会话状态。");
    };
    const parse = (eventType: string, event: MessageEvent): Record<string, unknown> | undefined => {
      if (!active || sourceRef.current !== source || projectionRecovering) return undefined;
      try {
        const value: unknown = JSON.parse(event.data);
        if (isRecord(value)) return value;
      } catch {
        // 损坏的单条 SSE 交由权威 Projection 恢复，避免继续消费可能存在缺口的增量。
      }
      reportInvalidEvent(eventType, "parse");
      return undefined;
    };
    const accept = (payload: Record<string, unknown>): boolean => {
      if (!active || sourceRef.current !== source || projectionRecovering) return false;
      if (payload.sessionId !== options.sessionId
        || typeof payload.id !== "number"
        || !Number.isSafeInteger(payload.id)
        || payload.id < 1) {
        reportInvalidEvent(typeof payload.type === "string" ? payload.type : "unknown", "identity", payload);
        return false;
      }
      const id = payload.id;
      if (id <= lastEventIdRef.current) {
        return false;
      }
      lastEventIdRef.current = id;
      return true;
    };

    source.addEventListener("open", () => setReconnecting(false));
    source.addEventListener("snapshot", (rawEvent) => {
      if (projectionRecovering) return;
      const payload = parse("snapshot", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionSnapshotEvent(payload)) {
        reportInvalidEvent("snapshot", "schema", payload);
        return;
      }
      const snapshot = readSnapshot(payload);
      if (!snapshot || snapshot.id !== options.sessionId) {
        reportInvalidEvent("snapshot", "identity", payload);
        return;
      }
      flushDeltas();
      lastEventIdRef.current = snapshot.lastEventId;
      callbacksRef.current.onSnapshot(snapshot);
      if (isActiveRun(snapshot.run)) {
        callbacksRef.current.onRunChange(snapshot.run);
        callbacksRef.current.onTimelineEvent({ type: "generation_started" });
      } else {
        callbacksRef.current.onRunChange(undefined);
        if (snapshot.run) {
          const outcome = snapshot.run.status === "completed"
            ? "completed"
            : snapshot.run.status === "aborted"
              ? "aborted"
              : "error";
          callbacksRef.current.onTimelineEvent({ type: "generation_finished", outcome });
        }
      }
    });
    source.addEventListener("projection_required", (rawEvent) => {
      const payload = parse("projection_required", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isProjectionRequiredEvent(payload)) {
        reportInvalidEvent("projection_required", "schema", payload);
        return;
      }
      if (payload.sessionId !== options.sessionId) {
        reportInvalidEvent("projection_required", "identity", payload);
        return;
      }
      // 恢复 Projection 期间暂停增量输入，避免迟到快照覆盖已经应用的更高序号事件。
      recoverProjection();
    });
    source.addEventListener("run_started", (rawEvent) => {
      const payload = parse("run_started", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "run_started") {
        reportInvalidEvent("run_started", "schema", payload);
        return;
      }
      if (!accept(payload)) {
        return;
      }
      flushDeltas();
      const run = readRun(payload.run);
      if (run) {
        callbacksRef.current.onRunChange(run);
      }
      callbacksRef.current.onTimelineEvent({ type: "generation_started" });
    });
    source.addEventListener("model_changed", (rawEvent) => {
      const payload = parse("model_changed", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "model_changed") {
        reportInvalidEvent("model_changed", "schema", payload);
        return;
      }
      if (!accept(payload)) return;
      callbacksRef.current.onModelChange?.(payload.model);
    });
    source.addEventListener("thinking_level_changed", (rawEvent) => {
      const payload = parse("thinking_level_changed", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "thinking_level_changed") {
        reportInvalidEvent("thinking_level_changed", "schema", payload);
        return;
      }
      if (!accept(payload)) return;
      callbacksRef.current.onThinkingLevelChange?.(payload.thinkingLevel);
    });
    source.addEventListener("session_renamed", (rawEvent) => {
      const payload = parse("session_renamed", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "session_renamed") {
        reportInvalidEvent("session_renamed", "schema", payload);
        return;
      }
      if (!accept(payload)) return;
      callbacksRef.current.onSessionRenamed?.(payload.sessionId, payload.name);
    });
    source.addEventListener("question_pending", (rawEvent) => {
      const payload = parse("question_pending", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "question_pending") {
        reportInvalidEvent("question_pending", "schema", payload);
        return;
      }
      if (!accept(payload)) return;
      flushDeltas();
      callbacksRef.current.onPendingQuestion?.(payload.pendingQuestion);
    });
    source.addEventListener("question_resolved", (rawEvent) => {
      const payload = parse("question_resolved", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "question_resolved") {
        reportInvalidEvent("question_resolved", "schema", payload);
        return;
      }
      if (!accept(payload)) return;
      flushDeltas();
      callbacksRef.current.onQuestionResolved?.({
        questionRecordId: payload.questionRecordId,
        state: payload.state,
      });
    });
    source.addEventListener("text_delta", (rawEvent) => {
      const payload = parse("text_delta", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "text_delta") {
        reportInvalidEvent("text_delta", "schema", payload);
        return;
      }
      if (accept(payload) && typeof payload.delta === "string") {
        enqueueDelta({ type: "text_delta", delta: payload.delta });
      }
    });
    source.addEventListener("thinking_delta", (rawEvent) => {
      const payload = parse("thinking_delta", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "thinking_delta") {
        reportInvalidEvent("thinking_delta", "schema", payload);
        return;
      }
      if (accept(payload) && typeof payload.delta === "string") {
        callbacksRef.current.onTimelineEvent({ type: "thinking_delta", delta: payload.delta });
      }
    });
    source.addEventListener("thinking_finished", (rawEvent) => {
      const payload = parse("thinking_finished", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "thinking_finished") {
        reportInvalidEvent("thinking_finished", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({ type: "thinking_finished" });
      }
    });
    source.addEventListener("tool_preparing", (rawEvent) => {
      const payload = parse("tool_preparing", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "tool_preparing") {
        reportInvalidEvent("tool_preparing", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({
          type: "tool_preparing",
          callId: payload.callId,
          toolName: payload.toolName,
        });
      }
    });
    source.addEventListener("tool_parameters_streaming", (rawEvent) => {
      const payload = parse("tool_parameters_streaming", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "tool_parameters_streaming") {
        reportInvalidEvent("tool_parameters_streaming", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({
          type: "tool_parameters_streaming",
          callId: payload.callId,
          toolName: payload.toolName,
          generatedBytes: payload.generatedBytes,
          ...(payload.path ? { path: payload.path } : {}),
        });
      }
    });
    source.addEventListener("tool_prepared", (rawEvent) => {
      const payload = parse("tool_prepared", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "tool_prepared") {
        reportInvalidEvent("tool_prepared", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({
          type: "tool_prepared",
          callId: payload.callId,
          toolName: payload.toolName,
          args: payload.args,
        });
      }
    });
    source.addEventListener("tool_started", (rawEvent) => {
      const payload = parse("tool_started", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "tool_started") {
        reportInvalidEvent("tool_started", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({
          type: "tool_started",
          callId: String(payload.callId),
          toolName: String(payload.toolName),
          args: payload.args,
        });
      }
    });
    source.addEventListener("tool_updated", (rawEvent) => {
      const payload = parse("tool_updated", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "tool_updated") {
        reportInvalidEvent("tool_updated", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({
          type: "tool_updated",
          callId: String(payload.callId),
          toolName: String(payload.toolName),
          partialResult: payload.partialResult,
        });
      }
    });
    source.addEventListener("tool_finished", (rawEvent) => {
      const payload = parse("tool_finished", rawEvent as MessageEvent);
      if (!payload) return;
      if (!isSessionEvent(payload) || payload.type !== "tool_finished") {
        reportInvalidEvent("tool_finished", "schema", payload);
        return;
      }
      if (accept(payload)) {
        flushDeltas();
        callbacksRef.current.onTimelineEvent({
          type: "tool_finished",
          callId: String(payload.callId),
          toolName: String(payload.toolName),
          result: payload.result,
          isError: payload.isError === true,
        });
      }
    });
    (["completed", "aborted", "error"] as const).forEach((type) => {
      source.addEventListener(type, (rawEvent) => {
        const payload = parse(type, rawEvent as MessageEvent);
        if (!payload) return;
        if (!isSessionEvent(payload) || payload.type !== type) {
          reportInvalidEvent(type, "schema", payload);
          return;
        }
        if (!accept(payload)) {
          return;
        }
        flushDeltas();
        callbacksRef.current.onRunChange(undefined);
        callbacksRef.current.onTimelineEvent({ type: "generation_finished", outcome: type });
        if (type === "error" && payload.type === "error") {
          callbacksRef.current.onError(payload.message);
        }
      });
    });
    source.onerror = () => {
      if (!active || sourceRef.current !== source || projectionRecovering) return;
      setReconnecting(true);
    };

    return () => {
      active = false;
      if (refreshProjectionRef.current === recoverProjection) {
        refreshProjectionRef.current = () => undefined;
      }
      recoveryController?.abort();
      closeTransport();
    };
  }, [closeTransport, enqueueDelta, flushDeltas, options.sessionId, reconnectRequest?.nonce]);

  const ensureOpen = useCallback(async () => {
    const source = sourceRef.current;
    if (!source) {
      throw new Error("实时连接尚未创建。");
    }
    if (source.readyState === EventSource.OPEN) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("实时连接建立超时。")), 5_000);
      source.addEventListener("open", () => {
        window.clearTimeout(timeout);
        resolve();
      }, { once: true });
    });
  }, []);

  const refreshProjection = useCallback(() => {
    refreshProjectionRef.current();
  }, []);

  return { ensureOpen, refreshProjection, close, reconnecting };
}

function readSnapshot(payload: Record<string, unknown>): SessionSnapshot | undefined {
  if (typeof payload.sessionId !== "string"
    || !Array.isArray(payload.messages)
    || !isSessionHistoryPage(payload.history)
    || typeof payload.lastEventId !== "number"
    || !Number.isSafeInteger(payload.lastEventId)
    || payload.lastEventId < 0) {
    return undefined;
  }
  return {
    id: payload.sessionId,
    messages: payload.messages,
    history: { ...payload.history },
    model: readModel(payload.model),
    pendingQuestion: Check(PendingQuestionProjectionSchema, payload.pendingQuestion)
      ? payload.pendingQuestion
      : undefined,
    run: readRun(payload.run),
    lastEventId: payload.lastEventId,
  };
}

function readModel(value: unknown): ModelSummary | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") {
    return undefined;
  }
  return {
    provider: value.provider,
    id: value.id,
    name: typeof value.name === "string" ? value.name : value.id,
  };
}

function readRun(value: unknown): ChatRunSummary | undefined {
  if (!isRecord(value)
    || typeof value.runId !== "string"
    || typeof value.sessionId !== "string"
    || typeof value.status !== "string"
    || typeof value.startedAt !== "string") {
    return undefined;
  }
  if (!["queued", "running", "completed", "aborted", "error", "interrupted"].includes(value.status)) {
    return undefined;
  }
  return {
    runId: value.runId,
    sessionId: value.sessionId,
    status: value.status as ChatRunSummary["status"],
    startedAt: value.startedAt,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : undefined,
    error: typeof value.error === "string" ? value.error : undefined,
  };
}

function isActiveRun(run: ChatRunSummary | undefined): run is ChatRunSummary & { status: "queued" | "running" } {
  return run?.status === "queued" || run?.status === "running";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
