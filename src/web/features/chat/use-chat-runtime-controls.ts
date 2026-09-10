import { useCallback, useRef, useState } from "react";
import type { AgentProfileDocument } from "../../../shared/agent-contracts";
import { THINKING_LEVELS, type ThinkingLevel } from "../../../shared/configuration-contracts";
import { api, type ModelSummary, type SessionSnapshot } from "../../api";
import {
  type ChatInteractionTicket,
  ChatInteractionCoordinator,
} from "./chat-interaction-coordinator";

interface RuntimePatch {
  model?: ModelSummary;
  thinkingLevel?: ThinkingLevel;
}

interface RuntimePersistence {
  setModel(sessionId: string, provider: string, modelId: string): Promise<void>;
  setThinkingLevel(sessionId: string, thinkingLevel: ThinkingLevel): Promise<void>;
}

interface UseChatRuntimeControlsOptions {
  coordinator: ChatInteractionCoordinator;
  guardInteraction(ticket: ChatInteractionTicket, checkpoint: string): boolean;
  onSessionRuntimeChange(sessionId: string, patch: RuntimePatch): void;
  onFailure(reason: unknown, operation: string): Promise<unknown> | unknown;
  persistence?: RuntimePersistence;
}

interface PendingModelIntent {
  sessionId: string;
  ticket: ChatInteractionTicket;
  model: ModelSummary;
  thinkingLevel: ThinkingLevel;
}

interface PendingThinkingIntent {
  sessionId: string;
  ticket: ChatInteractionTicket;
  thinkingLevel: ThinkingLevel;
}

interface RuntimeContext {
  sessionId?: string;
  confirmedModel?: ModelSummary;
  confirmedThinkingLevel: ThinkingLevel;
}

/**
 * 统一管理聊天模型与思考深度的乐观选择、串行持久化和权威事件回写。
 */
export function useChatRuntimeControls({
  coordinator,
  guardInteraction,
  onSessionRuntimeChange,
  onFailure,
  persistence = api,
}: UseChatRuntimeControlsOptions) {
  const [selectedModel, setSelectedModelState] = useState<ModelSummary>();
  const [selectedThinkingLevel, setSelectedThinkingLevelState] = useState<ThinkingLevel>("medium");
  const [runtimeChanging, setRuntimeChanging] = useState(false);
  const selectedModelRef = useRef<ModelSummary | undefined>(undefined);
  const selectedThinkingLevelRef = useRef<ThinkingLevel>("medium");
  const contextRef = useRef<RuntimeContext>({ confirmedThinkingLevel: "medium" });
  const pendingModelIntentRef = useRef<PendingModelIntent | undefined>(undefined);
  const pendingThinkingIntentRef = useRef<PendingThinkingIntent | undefined>(undefined);
  const mutationQueuesRef = useRef(new Map<string, Promise<void>>());

  const setSelectedModel = useCallback((model: ModelSummary | undefined) => {
    selectedModelRef.current = model;
    setSelectedModelState(model);
  }, []);

  const setSelectedThinkingLevel = useCallback((thinkingLevel: ThinkingLevel) => {
    selectedThinkingLevelRef.current = thinkingLevel;
    setSelectedThinkingLevelState(thinkingLevel);
  }, []);

  /** 同一 Session 的模型和思考深度共享队列，避免两类设置交叉覆盖。 */
  const enqueueMutation = useCallback((sessionId: string, mutation: () => Promise<void>): Promise<void> => {
    const previous = mutationQueuesRef.current.get(sessionId) ?? Promise.resolve();
    const request = previous.then(mutation, mutation);
    const settled = request.then(() => undefined, () => undefined);
    mutationQueuesRef.current.set(sessionId, settled);
    void settled.then(() => {
      if (mutationQueuesRef.current.get(sessionId) === settled) {
        mutationQueuesRef.current.delete(sessionId);
      }
    });
    return request;
  }, []);

  const hasPendingModel = useCallback((sessionId: string): PendingModelIntent | undefined => {
    const pending = pendingModelIntentRef.current;
    return pending?.sessionId === sessionId && coordinator.isCurrent(pending.ticket) ? pending : undefined;
  }, [coordinator]);

  const hasPendingThinkingLevel = useCallback((sessionId: string): PendingThinkingIntent | undefined => {
    const pending = pendingThinkingIntentRef.current;
    return pending?.sessionId === sessionId && coordinator.isCurrent(pending.ticket) ? pending : undefined;
  }, [coordinator]);

  const refreshRuntimeChanging = useCallback(() => {
    setRuntimeChanging(Boolean(pendingModelIntentRef.current || pendingThinkingIntentRef.current));
  }, []);

  /** 从 Session 快照同步权威配置，但不让旧快照覆盖尚未完成的最新点击。 */
  const applySnapshotRuntime = useCallback((snapshot: SessionSnapshot) => {
    const previous = contextRef.current;
    const sessionChanged = previous.sessionId !== snapshot.id;
    contextRef.current = {
      sessionId: snapshot.id,
      confirmedModel: snapshot.model ?? (sessionChanged ? selectedModelRef.current : previous.confirmedModel),
      confirmedThinkingLevel: snapshot.thinkingLevel
        ?? (sessionChanged ? selectedThinkingLevelRef.current : previous.confirmedThinkingLevel),
    };
    if (snapshot.model && !hasPendingModel(snapshot.id)) setSelectedModel(snapshot.model);
    if (snapshot.thinkingLevel && !hasPendingThinkingLevel(snapshot.id) && !hasPendingModel(snapshot.id)) {
      setSelectedThinkingLevel(snapshot.thinkingLevel);
    }
  }, [hasPendingModel, hasPendingThinkingLevel, setSelectedModel, setSelectedThinkingLevel]);

  /** 进入草稿态时按 Agent 配置重建运行时选择。 */
  const initializeForAgent = useCallback((
    agent: AgentProfileDocument | undefined,
    models: ModelSummary[],
    globalDefaultModel?: { provider: string; id: string },
  ) => {
    const model = findAgentModel(agent, models, globalDefaultModel);
    const thinkingLevel = findAgentThinkingLevel(agent, model);
    contextRef.current = {
      confirmedModel: model,
      confirmedThinkingLevel: thinkingLevel,
    };
    pendingModelIntentRef.current = undefined;
    pendingThinkingIntentRef.current = undefined;
    setRuntimeChanging(false);
    setSelectedModel(model);
    setSelectedThinkingLevel(thinkingLevel);
  }, [setSelectedModel, setSelectedThinkingLevel]);

  /** 接收 SSE 模型事件；有更新的本地意图时只更新确认值，不制造界面回跳。 */
  const applyModelEvent = useCallback((sessionId: string, model: ModelSummary) => {
    if (contextRef.current.sessionId !== sessionId) return;
    contextRef.current.confirmedModel = model;
    onSessionRuntimeChange(sessionId, { model });
    const pending = hasPendingModel(sessionId);
    if (!pending || isSameModel(pending.model, model)) setSelectedModel(model);
  }, [hasPendingModel, onSessionRuntimeChange, setSelectedModel]);

  /** 接收 SSE 思考深度事件，并保护模型切换带来的配套归一化选择。 */
  const applyThinkingLevelEvent = useCallback((sessionId: string, thinkingLevel: ThinkingLevel) => {
    if (contextRef.current.sessionId !== sessionId) return;
    contextRef.current.confirmedThinkingLevel = thinkingLevel;
    onSessionRuntimeChange(sessionId, { thinkingLevel });
    const pendingThinking = hasPendingThinkingLevel(sessionId);
    const pendingModel = hasPendingModel(sessionId);
    if (pendingThinking && pendingThinking.thinkingLevel !== thinkingLevel) return;
    if (pendingModel && pendingModel.thinkingLevel !== thinkingLevel) return;
    setSelectedThinkingLevel(thinkingLevel);
  }, [hasPendingModel, hasPendingThinkingLevel, onSessionRuntimeChange, setSelectedThinkingLevel]);

  const changeModel = useCallback(async (model: ModelSummary) => {
    const targetSessionId = contextRef.current.sessionId;
    const thinkingLevel = normalizeThinkingLevelForModel(selectedThinkingLevelRef.current, model);
    const ticket = coordinator.begin("model-change", {
      sessionId: targetSessionId ?? "draft",
      provider: model.provider,
      modelId: model.id,
    });
    setSelectedModel(model);
    setSelectedThinkingLevel(thinkingLevel);
    if (!targetSessionId) {
      contextRef.current = { confirmedModel: model, confirmedThinkingLevel: thinkingLevel };
      coordinator.finish(ticket, "applied", { draft: true });
      return;
    }
    pendingModelIntentRef.current = { sessionId: targetSessionId, ticket, model, thinkingLevel };
    refreshRuntimeChanging();
    try {
      await enqueueMutation(targetSessionId, () => persistence.setModel(targetSessionId, model.provider, model.id));
      const pending = pendingModelIntentRef.current;
      const stillOwned = coordinator.isCurrent(ticket)
        || (pending?.sessionId === targetSessionId && coordinator.isCurrent(pending.ticket));
      if (contextRef.current.sessionId === targetSessionId && stillOwned) {
        // 更早选择已经真实落盘时更新回滚基准，但不覆盖后续乐观选择。
        contextRef.current.confirmedModel = model;
        onSessionRuntimeChange(targetSessionId, { model });
      }
      if (!guardInteraction(ticket, "model-response") || contextRef.current.sessionId !== targetSessionId) return;
      if (pendingModelIntentRef.current?.ticket === ticket) pendingModelIntentRef.current = undefined;
      refreshRuntimeChanging();
      coordinator.finish(ticket, "applied", { sessionId: targetSessionId });
    } catch (reason) {
      if (!guardInteraction(ticket, "model-error") || contextRef.current.sessionId !== targetSessionId) return;
      if (pendingModelIntentRef.current?.ticket === ticket) pendingModelIntentRef.current = undefined;
      refreshRuntimeChanging();
      const confirmedModel = contextRef.current.confirmedModel;
      setSelectedModel(confirmedModel);
      setSelectedThinkingLevel(normalizeThinkingLevelForModel(
        contextRef.current.confirmedThinkingLevel,
        confirmedModel,
      ));
      coordinator.finish(ticket, "failed", { sessionId: targetSessionId });
      await onFailure(reason, "切换会话模型");
    }
  }, [coordinator, enqueueMutation, guardInteraction, onFailure, onSessionRuntimeChange, persistence, refreshRuntimeChanging, setSelectedModel, setSelectedThinkingLevel]);

  const changeThinkingLevel = useCallback(async (requestedThinkingLevel: ThinkingLevel) => {
    const targetSessionId = contextRef.current.sessionId;
    const thinkingLevel = normalizeThinkingLevelForModel(requestedThinkingLevel, selectedModelRef.current);
    const ticket = coordinator.begin("thinking-level-change", {
      sessionId: targetSessionId ?? "draft",
      thinkingLevel,
    });
    setSelectedThinkingLevel(thinkingLevel);
    if (!targetSessionId) {
      contextRef.current.confirmedThinkingLevel = thinkingLevel;
      coordinator.finish(ticket, "applied", { draft: true });
      return;
    }
    pendingThinkingIntentRef.current = { sessionId: targetSessionId, ticket, thinkingLevel };
    refreshRuntimeChanging();
    try {
      await enqueueMutation(targetSessionId, () => persistence.setThinkingLevel(targetSessionId, thinkingLevel));
      const pending = pendingThinkingIntentRef.current;
      const stillOwned = coordinator.isCurrent(ticket)
        || (pending?.sessionId === targetSessionId && coordinator.isCurrent(pending.ticket));
      if (contextRef.current.sessionId === targetSessionId && stillOwned) {
        // 队列前项成功后同步确认值，供后项失败时恢复真实服务端状态。
        contextRef.current.confirmedThinkingLevel = thinkingLevel;
        onSessionRuntimeChange(targetSessionId, { thinkingLevel });
      }
      if (!guardInteraction(ticket, "thinking-response") || contextRef.current.sessionId !== targetSessionId) return;
      if (pendingThinkingIntentRef.current?.ticket === ticket) pendingThinkingIntentRef.current = undefined;
      refreshRuntimeChanging();
      coordinator.finish(ticket, "applied", { sessionId: targetSessionId });
    } catch (reason) {
      if (!guardInteraction(ticket, "thinking-error") || contextRef.current.sessionId !== targetSessionId) return;
      if (pendingThinkingIntentRef.current?.ticket === ticket) pendingThinkingIntentRef.current = undefined;
      refreshRuntimeChanging();
      setSelectedThinkingLevel(normalizeThinkingLevelForModel(
        contextRef.current.confirmedThinkingLevel,
        selectedModelRef.current,
      ));
      coordinator.finish(ticket, "failed", { sessionId: targetSessionId });
      await onFailure(reason, "切换思考深度");
    }
  }, [coordinator, enqueueMutation, guardInteraction, onFailure, onSessionRuntimeChange, persistence, refreshRuntimeChanging, setSelectedThinkingLevel]);

  /** 会话归属变化时立即废弃旧配置请求的页面回写资格。 */
  const invalidateSessionRuntime = useCallback((reason: string) => {
    coordinator.invalidate("model-change", reason);
    coordinator.invalidate("thinking-level-change", reason);
    pendingModelIntentRef.current = undefined;
    pendingThinkingIntentRef.current = undefined;
    setRuntimeChanging(false);
  }, [coordinator]);

  return {
    selectedModel,
    selectedThinkingLevel,
    runtimeChanging,
    applySnapshotRuntime,
    initializeForAgent,
    applyModelEvent,
    applyThinkingLevelEvent,
    changeModel,
    changeThinkingLevel,
    invalidateSessionRuntime,
  };
}

/** 优先选择 Agent 默认模型，未覆盖时沿用全局默认模型。 */
export function findAgentModel(
  agent: AgentProfileDocument | undefined,
  models: ModelSummary[],
  globalDefaultModel?: { provider: string; id: string },
): ModelSummary | undefined {
  const defaultModel = agent?.profile?.defaultModel ?? globalDefaultModel;
  return models.find((model) => model.provider === defaultModel?.provider && model.id === defaultModel.id) ?? models[0];
}

/** 根据模型能力选择 Agent 的初始思考深度。 */
export function findAgentThinkingLevel(agent: AgentProfileDocument | undefined, model: ModelSummary | undefined): ThinkingLevel {
  return normalizeThinkingLevelForModel(agent?.profile?.defaultThinkingLevel ?? "medium", model);
}

/** 将思考深度收敛到当前模型实际支持的最近档位。 */
export function normalizeThinkingLevelForModel(
  thinkingLevel: ThinkingLevel,
  model: ModelSummary | undefined,
): ThinkingLevel {
  const available = model?.thinkingLevels;
  if (!available?.length || available.includes(thinkingLevel)) return thinkingLevel;
  const requestedIndex = THINKING_LEVELS.indexOf(thinkingLevel);
  for (let index = requestedIndex + 1; index < THINKING_LEVELS.length; index += 1) {
    const candidate = THINKING_LEVELS[index]!;
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = THINKING_LEVELS[index]!;
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

/** 判断两个模型是否指向同一运行时配置。 */
export function isSameModel(left: ModelSummary | undefined, right: ModelSummary | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}
