import { ChevronDown, CircleStop, Menu, MessageSquarePlus, PencilLine, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import type { ChatRunSummary, WorkspaceFileSummary } from "../../shared/contracts";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { api, type ModelSummary, type SessionBulkAction, type SessionBulkPreview, type SessionBulkTarget, type SessionSnapshot, type SessionSummary } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { AgentModelMenu } from "../components/agent-model-menu";
import { AttachmentPicker, AttachmentPickerButton, type AttachmentUploadItem, validateAttachmentSelection } from "../components/attachment-picker";
import { ReferenceComposer } from "../components/reference-composer";
import { MediaLightbox } from "../components/media-lightbox";
import { ArchivedSessionsDialog } from "../components/archived-sessions-dialog";
import { SessionBulkConfirmationDialog } from "../components/session-bulk-confirmation-dialog";
import {
  parsePiHistory,
  reduceTimeline,
  type AgentTurn,
  type ConversationEntry,
  type UserEntry,
} from "../conversation-timeline";
import type { IdentityPreview } from "./chat-page";
import type { ThemePreference } from "../theme";
import { useMessageAutofollow } from "../use-message-autofollow";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { useSessionStream } from "../use-session-stream";
import { useSessionHistory } from "../use-session-history";
import { mergeOlderHistory, reconcileSnapshotMessages } from "../session-history";
import {
  createPendingUserMessage,
  reconcilePendingUserMessage,
  type PendingUserMessage,
} from "../pending-user-message";
import { createSessionListSync, type SessionListSync } from "../session-sync";
import { navigateTo, WORKBENCH_NAVIGATION_TOGGLE_EVENT } from "../router";
import type { AgentReference } from "../../shared/agent-reference-contracts";
import { ChatSidebar } from "../features/chat/components/chat-sidebar";
import { ConversationTimelineView } from "../features/chat/components/conversation-timeline-view";
import { ProfileDialog } from "../features/chat/components/profile-dialog";
import { useMobileSidebarSwipe } from "../features/chat/mobile-sidebar-swipe";
import { agentTurnSpeechText, prepareSpeechSegments } from "../speech-text";
import { StreamingTtsController, type SpeechPlaybackState } from "../streaming-tts-controller";
import { PcmStreamAudio } from "../pcm-stream-audio";

interface LiveChatPageProps {
  theme: ThemePreference;
  userIdentity: IdentityPreview;
}

interface AutoSpeechEligibility {
  /** 用户本次发送所在的 Session。 */
  sessionId: string;

  /** 发送前最后一个 Agent turn，用于排除历史回答。 */
  previousTurnId?: string;

  /** 本次发送后绑定的新 Agent turn。 */
  turnId?: string;
}

interface SpeechControllerEntry {
  /** 控制器绑定的 Agent。 */
  agentId: string;

  /** 负责该 Agent 合成请求的播放控制器。 */
  controller: StreamingTtsController;
}

type SnapshotAlignment = "follow" | "once";

const SELECTED_AGENT_STORAGE_KEY = "pi-agent-web.selected-agent-id";
const SESSION_LONG_PRESS_DURATION_MS = 450;
const SESSION_SCROLLBAR_HIDE_DELAY_MS = 700;

/** 将聊天、会话、模型和附件的可恢复业务错误保留在编辑器附近。 */
function chatExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_MESSAGE: show,
    INVALID_ATTACHMENT: show,
    INVALID_REFERENCE: show,
    UNKNOWN_COMMAND: show,
    SESSION_BUSY: show,
    SESSION_NOT_FOUND: show,
    SESSION_AGENT_CONFLICT: show,
    AGENT_ARCHIVED: show,
    INVALID_SESSION_NAME: show,
    SCHEDULED_TASKS_BOUND: show,
    SESSION_BULK_PREVIEW_STALE: show,
    SESSION_AGENT_MISSING: show,
    OPERATION_ABORTED: show,
    RUNTIME_GENERATION_RETIRED: show,
    CLIENT_TOO_SLOW: show,
    VALIDATION_FAILED: show,
    INVALID_MODEL: show,
    MODEL_NOT_FOUND: show,
    PROVIDER_NOT_FOUND: show,
    MODEL_RUNTIME_UNAVAILABLE: show,
    EMPTY_UPLOAD: show,
    ATTACHMENT_TOO_LARGE: show,
    TOO_MANY_ATTACHMENTS: show,
    AGENT_NOT_FOUND: show,
  };
}

/**
 * 接入真实会话 API 与 SSE 的第一版对话工作台。
 */
export function LiveChatPage({ theme, userIdentity }: LiveChatPageProps) {
  useViewportScrollLock();
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([]);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [sessionSelectionMode, setSessionSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [sessionBulkPreview, setSessionBulkPreview] = useState<SessionBulkPreview>();
  const [sessionBulkBusy, setSessionBulkBusy] = useState(false);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [selectedModel, setSelectedModel] = useState<ModelSummary>();
  const [globalDefaultModel, setGlobalDefaultModel] = useState<{ provider: string; id: string }>();
  const [openingSessionId, setOpeningSessionId] = useState<string>();
  const [session, setSession] = useState<SessionSnapshot>();
  const [timeline, setTimeline] = useState<ConversationEntry[]>([]);
  const [mediaSummaries, setMediaSummaries] = useState<Record<string, WorkspaceFileSummary>>({});
  const [previewImage, setPreviewImage] = useState<WorkspaceFileSummary>();
  const [draft, setDraft] = useState("");
  /** 正在编辑的历史用户消息；仅在实际发送时用于创建 Pi 分支。 */
  const [editingEntryId, setEditingEntryId] = useState<string>();
  const [draftReferences, setDraftReferences] = useState<AgentReference[]>([]);
  const [activeRun, setActiveRun] = useState<ChatRunSummary>();
  const [error, setError] = useState("");
  const reportFailure = useCallback((reason: unknown, operation: string) => runApiTask(
    async () => { throw reason; },
    { operation, expected: chatExpected(setError) },
  ), [runApiTask]);
  const [attachmentItems, setAttachmentItems] = useState<AttachmentUploadItem[]>([]);
  const editingEntry = editingEntryId
    ? timeline.find((entry): entry is UserEntry => entry.type === "user" && entry.piEntryId === editingEntryId)
    : undefined;
  const [profileIdentity, setProfileIdentity] = useState<IdentityPreview>(userIdentity);
  const [profileRevision, setProfileRevision] = useState<string>();
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState(userIdentity.displayName);
  const [profileSaving, setProfileSaving] = useState(false);
  const [sessionNavScrolling, setSessionNavScrolling] = useState(false);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const sessionSyncRef = useRef<SessionListSync | undefined>(undefined);
  const openingSessionRef = useRef<string | undefined>(undefined);
  const sessionLongPressTimerRef = useRef<number | undefined>(undefined);
  const sessionScrollHideTimerRef = useRef<number | undefined>(undefined);
  const suppressSessionOpenRef = useRef<string | undefined>(undefined);
  const [sessionActionsOpenRequest, setSessionActionsOpenRequest] = useState<{ sessionId: string; requestId: number }>();
  const initialSseSnapshotRef = useRef<{ id: string; lastEventId: number } | undefined>(undefined);
  const pendingUserMessageRef = useRef<PendingUserMessage | undefined>(undefined);
  const agentSelectionGenerationRef = useRef(0);
  const modelChangeGenerationRef = useRef(0);
  const modelChangeQueueRef = useRef<Promise<void>>(Promise.resolve());
  const selectedAgentIdRef = useRef<string | undefined>(selectedAgentId);
  const sessionIdRef = useRef<string | undefined>(session?.id);
  const sessionSnapshotRef = useRef<SessionSnapshot | undefined>(session);
  const autoSpeechEligibilityRef = useRef<AutoSpeechEligibility | undefined>(undefined);
  const speechControllerRef = useRef<SpeechControllerEntry | undefined>(undefined);
  const [speechState, setSpeechState] = useState<SpeechPlaybackState>({ phase: "idle" });
  selectedAgentIdRef.current = selectedAgentId;
  sessionIdRef.current = session?.id;
  sessionSnapshotRef.current = session;
  const {
    scrollContainerRef: messageScrollRef,
    contentRef: messageContentRef,
    resumeFollowing,
    pauseFollowing,
    alignAfterNextContentCommit,
  } = useMessageAutofollow(timeline);

  const applySnapshot = useCallback((next: SessionSnapshot, alignment: SnapshotAlignment = "follow") => {
    if (alignment === "once") {
      initialSseSnapshotRef.current = { id: next.id, lastEventId: next.lastEventId };
      alignAfterNextContentCommit();
    } else {
      const initialSseSnapshot = initialSseSnapshotRef.current;
      initialSseSnapshotRef.current = undefined;
      if (initialSseSnapshot?.id === next.id && initialSseSnapshot.lastEventId === next.lastEventId) {
        return;
      }
      resumeFollowing();
    }
    const reconciled = reconcileSnapshotMessages(sessionSnapshotRef.current, next);
    const mergedSnapshot = { ...next, messages: reconciled.messages };
    sessionSnapshotRef.current = mergedSnapshot;
    setSession(mergedSnapshot);
    if (next.model) setSelectedModel(next.model);
    const running = next.run?.status === "queued" || next.run?.status === "running";
    const pendingResult = reconcilePendingUserMessage(
      next.id,
      parsePiHistory(mergedSnapshot.messages, running),
      pendingUserMessageRef.current,
    );
    pendingUserMessageRef.current = pendingResult.pending;
    setTimeline(pendingResult.timeline);
  }, [alignAfterNextContentCommit, resumeFollowing]);

  const historyLoader = useSessionHistory({
    snapshot: session,
    scrollRef: messageScrollRef,
    onBeforePrepend: pauseFollowing,
    onPrepend: (page) => {
      setSession((current) => {
        if (!current || current.id !== page.sessionId || current.history.branchToken !== page.history.branchToken) return current;
        const messages = mergeOlderHistory(current.messages, page.messages);
        const merged = { ...current, messages, history: page.history };
        sessionSnapshotRef.current = merged;
        setTimeline(parsePiHistory(messages, current.run?.status === "queued" || current.run?.status === "running"));
        return merged;
      });
    },
    onError: (reason) => { void reportFailure(reason, "加载更早消息"); },
  });

  const stream = useSessionStream({
    sessionId: session?.id,
    onSnapshot: applySnapshot,
    onTimelineEvent: (event) => setTimeline((current) => reduceTimeline(current, event)),
    onRunChange: setActiveRun,
    onModelChange: (model) => {
      setSession((current) => current ? { ...current, model } : current);
      setSelectedModel(model);
    },
    onSessionRenamed: (sessionId, name) => {
      setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, name } : item));
      sessionSyncRef.current?.notify();
    },
    onError: setError,
    onUnexpectedError: (reason) => void reportFailure(reason, "恢复会话实时连接"),
  });

  const registerMediaSummary = useCallback((summary: WorkspaceFileSummary) => {
    setMediaSummaries((current) => current[summary.path] === summary ? current : { ...current, [summary.path]: summary });
  }, []);

  const openImagePreview = useCallback((summary: WorkspaceFileSummary) => {
    if (!summary.mediaType.startsWith("image/")) return;
    registerMediaSummary(summary);
    setPreviewImage(summary);
  }, [registerMediaSummary]);
  const streaming = activeRun?.status === "queued" || activeRun?.status === "running";
  const isOpeningSession = openingSessionId !== undefined;
  // 连接状态独立于业务错误，重连成功后提示会自然撤销且不会误清其他错误。
  const composerError = error || (stream.reconnecting ? "实时连接暂时中断，浏览器会自动重连。" : "");

  /** 获取当前 Agent 的唯一播放控制器，切换 Agent 时销毁旧实例。 */
  const ensureSpeechController = useCallback((agentId: string): StreamingTtsController => {
    const existing = speechControllerRef.current;
    if (existing?.agentId === agentId) {
      return existing.controller;
    }
    existing?.controller.destroy();
    const controller = new StreamingTtsController({
      request: async (text, signal) => {
        const response = await api.synthesizeAgentSpeech(agentId, text, signal);
        const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType === "audio/pcm" && response.body) {
          const audio = new PcmStreamAudio(response.body);
          return { audio, release: () => audio.pause() };
        }
        return response.blob();
      },
      createAudio: (url) => new Audio(url),
      onStateChange: setSpeechState,
      onError: (reason) => {
        const blocked = reason instanceof DOMException && reason.name === "NotAllowedError";
        if (blocked) {
          setError("浏览器阻止了自动播放，请先与页面交互后重试。");
          return;
        }
        void reportFailure(reason, "播放语音");
      },
    });
    speechControllerRef.current = { agentId, controller };
    return controller;
  }, [reportFailure]);

  /** 清除自动播放资格并同步停止当前音频与待处理队列。 */
  const stopSpeech = useCallback(() => {
    autoSpeechEligibilityRef.current = undefined;
    speechControllerRef.current?.controller.stop();
  }, []);

  useEffect(() => () => {
    autoSpeechEligibilityRef.current = undefined;
    speechControllerRef.current?.controller.destroy();
    speechControllerRef.current = undefined;
  }, []);

  useEffect(() => {
    let active = true;
    const generation = ++agentSelectionGenerationRef.current;
    const globalSettingsTask = runOptionalApiTask(
      () => api.getGlobalSettings(),
      {
        operation: "加载全局默认模型",
        fallbackReason: "全局默认模型是聊天初始化的可选配置",
        fallback: () => undefined,
      },
    );
    Promise.all([api.listAgents(), api.listModels(), globalSettingsTask])
      .then(async ([agentResult, modelResult, globalSettingsResult]) => {
        if (!active || generation !== agentSelectionGenerationRef.current) {
          return;
        }
        const globalSettings = globalSettingsResult.status === "success" ? globalSettingsResult.data : undefined;
        const defaultProvider = globalSettings?.effective?.defaultProvider;
        const defaultModel = globalSettings?.effective?.defaultModel;
        const inheritedModel = defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined;
        const availableAgents = agentResult.agents.filter((item) => item.profile.status === "active");
        const cachedAgentId = readCachedAgentId();
        const cachedAgent = availableAgents.find((item) => item.profile.id === cachedAgentId);
        const initialAgent = cachedAgent ?? availableAgents[0];
        if (cachedAgentId && !cachedAgent) {
          clearCachedAgentId();
        }
        const initialAgentId = initialAgent?.profile.id;
        setAgents(availableAgents);
        setSelectedAgentId(initialAgentId);
        setModels(modelResult.models);
        setGlobalDefaultModel(inheritedModel);
        setSelectedModel(findAgentModel(initialAgent, modelResult.models, inheritedModel));
        if (!initialAgentId) return;
        const sessionResult = await api.listSessions(initialAgentId);
        if (!active || generation !== agentSelectionGenerationRef.current) return;
        setSessions(sessionResult.sessions);
        if (sessionResult.sessions[0]) {
          const opened = await api.openSession(sessionResult.sessions[0].id);
          if (active && generation === agentSelectionGenerationRef.current) {
            applySnapshot(opened);
          }
        }
      })
      .catch((reason: unknown) => {
        if (active && generation === agentSelectionGenerationRef.current) {
          void reportFailure(reason, "加载聊天工作台");
        }
      });
    return () => {
      active = false;
    };
  }, [applySnapshot, reportFailure, runOptionalApiTask]);

  useEffect(() => {
    let active = true;
    void api.getProfile().then((document) => {
      if (!active) return;
      setProfileRevision(document.revision);
      setProfileIdentity(toIdentityPreview(document.profile));
      setProfileDisplayName(document.profile.displayName);
    }).catch((reason: unknown) => {
      if (active) void reportFailure(reason, "加载个人资料");
    });
    return () => { active = false; };
  }, [reportFailure]);

  useEffect(() => {
    let active = true;
    const sync = createSessionListSync(() => {
      if (selectedAgentId) {
        void api.listSessions(selectedAgentId)
          .then((result) => { if (active) setSessions(result.sessions); })
          .catch((reason: unknown) => { if (active) void reportFailure(reason, "同步会话列表"); });
        if (archiveDialogOpen) {
          void api.listSessions(selectedAgentId, true)
            .then((result) => { if (active) setArchivedSessions(result.sessions); })
            .catch((reason: unknown) => { if (active) void reportFailure(reason, "同步归档会话"); });
        }
      }
    });
    sessionSyncRef.current = sync;
    return () => {
      active = false;
      sync.close();
    };
  }, [archiveDialogOpen, reportFailure, selectedAgentId]);

  const createConversation = async (agentId: string) => {
    setError("");
    const created = await api.createSession(agentId);
    flushSync(() => applySnapshot(created));
    return created;
  };

  /** 退出批量模式并清理尚未执行的确认预览。 */
  const cancelSessionSelection = () => {
    setSessionSelectionMode(false);
    setSelectedSessionIds([]);
    setSessionBulkPreview(undefined);
  };

  /** 统一所有侧栏关闭入口，保证选择不会跨抽屉生命周期残留。 */
  const closeSidebar = () => {
    cancelSessionSelection();
    setSidebarOpen(false);
  };
  const sidebarSwipe = useMobileSidebarSwipe({
    open: sidebarOpen,
    onOpen: () => setSidebarOpen(true),
    onClose: closeSidebar,
  });

  const enterDraft = () => {
    stopSpeech();
    stream.close();
    setSession(undefined);
    setEditingEntryId(undefined);
    setTimeline([]);
    setMediaSummaries({});
    setPreviewImage(undefined);
    setActiveRun(undefined);
    setDraft("");
    setDraftReferences([]);
    setAttachmentItems([]);
    setError("");
    pendingUserMessageRef.current = undefined;
    closeSidebar();
  };

  const clearSessionLongPress = () => {
    if (sessionLongPressTimerRef.current === undefined) {
      return;
    }
    window.clearTimeout(sessionLongPressTimerRef.current);
    sessionLongPressTimerRef.current = undefined;
  };

  const clearSessionScrollbarTimer = () => {
    if (sessionScrollHideTimerRef.current === undefined) return;
    window.clearTimeout(sessionScrollHideTimerRef.current);
    sessionScrollHideTimerRef.current = undefined;
  };

  const showSessionNavScrollbar = () => {
    clearSessionScrollbarTimer();
    setSessionNavScrolling(true);
    sessionScrollHideTimerRef.current = window.setTimeout(() => {
      setSessionNavScrolling(false);
      sessionScrollHideTimerRef.current = undefined;
    }, SESSION_SCROLLBAR_HIDE_DELAY_MS);
  };

  const startSessionLongPress = (sessionId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType && event.pointerType !== "touch") {
      return;
    }
    clearSessionLongPress();
    sessionLongPressTimerRef.current = window.setTimeout(() => {
      // 长按后的合成点击不能再次打开会话。
      suppressSessionOpenRef.current = sessionId;
      setSessionActionsOpenRequest((current) => ({
        sessionId,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      sessionLongPressTimerRef.current = undefined;
    }, SESSION_LONG_PRESS_DURATION_MS);
  };

  useEffect(() => () => {
    clearSessionLongPress();
    clearSessionScrollbarTimer();
  }, []);

  const openConversation = async (sessionId: string) => {
    if (openingSessionRef.current || session?.id === sessionId) return;
    stopSpeech();
    pendingUserMessageRef.current = undefined;
    setError("");
    setEditingEntryId(undefined);
    setMediaSummaries({});
    setPreviewImage(undefined);
    openingSessionRef.current = sessionId;
    setOpeningSessionId(sessionId);
    try {
      applySnapshot(await api.openSession(sessionId), "once");
      closeSidebar();
    } catch (reason) {
      await reportFailure(reason, "打开会话");
    } finally {
      openingSessionRef.current = undefined;
      setOpeningSessionId(undefined);
    }
  };

  /**
   * 刷新当前 Agent 的会话摘要；仅在当前会话被移除时切换右侧聊天内容。
   */
  const refreshSessions = async () => {
    const agentId = selectedAgentIdRef.current;
    if (!agentId || refreshingSessions || openingSessionRef.current) return;
    setRefreshingSessions(true);
    try {
      const result = await api.listSessions(agentId);
      if (selectedAgentIdRef.current !== agentId) return;
      setSessions(result.sessions);
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId && !result.sessions.some((item) => item.id === activeSessionId)) {
        if (result.sessions[0]) {
          await openConversation(result.sessions[0].id);
        } else {
          enterDraft();
        }
      }
    } catch (reason) {
      await reportFailure(reason, "刷新会话列表");
    } finally {
      setRefreshingSessions(false);
    }
  };

  const renameConversation = async (sessionId: string, name: string) => {
    try {
      await api.renameSession(sessionId, name);
      setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, name } : item));
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "重命名会话");
    }
  };

  const archiveConversation = async (sessionId: string) => {
    try {
      await api.archiveSession(sessionId);
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      if (session?.id === sessionId) {
        enterDraft();
      }
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "归档会话");
    }
  };

  const deleteConversation = async (sessionId: string, archived = false, confirmBoundTasks = false) => {
    try {
      await api.deleteSession(sessionId, confirmBoundTasks);
      if (archived) {
        setArchivedSessions((current) => current.filter((item) => item.id !== sessionId));
      } else {
        setSessions((current) => current.filter((item) => item.id !== sessionId));
      }
      if (session?.id === sessionId) {
        enterDraft();
      }
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "删除会话");
    }
  };

  /** 从会话菜单进入多选，触发会话可操作时默认选中。 */
  const enterSessionSelection = (sessionId: string) => {
    const selectable = !(streaming && session?.id === sessionId);
    setSessionSelectionMode(true);
    setSelectedSessionIds(selectable ? [sessionId] : []);
    setSessionBulkPreview(undefined);
  };

  const toggleSessionSelection = (sessionId: string) => {
    if (streaming && session?.id === sessionId) return;
    setSelectedSessionIds((current) => current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId]);
  };

  /** 请求服务端稳定预览后才展示批量操作二次确认。 */
  const previewSessionBulk = async (action: SessionBulkAction, target?: SessionBulkTarget) => {
    const resolvedTarget = target ?? { mode: "selected", sessionIds: selectedSessionIds };
    if ((resolvedTarget.mode === "selected" && resolvedTarget.sessionIds.length === 0) || sessionBulkBusy) return;
    setSessionBulkBusy(true);
    setSessionBulkPreview(undefined);
    setError("");
    try {
      setSessionBulkPreview(await api.previewSessionBulk(action, resolvedTarget));
    } catch (reason) {
      await reportFailure(reason, "预览会话批量操作");
    } finally {
      setSessionBulkBusy(false);
    }
  };

  /** 使用预览指纹提交原子批量操作，并同步刷新本地会话列表。 */
  const executeSessionBulk = async () => {
    const preview = sessionBulkPreview;
    if (!preview || sessionBulkBusy) return;
    setSessionBulkBusy(true);
    setError("");
    try {
      const activeArchivedSession = preview.target.mode === "all_archived"
        && Boolean(session?.id && archivedSessions.some((item) => item.id === session.id));
      await api.executeSessionBulk(preview.action, preview.target, preview.fingerprint);
      if (preview.target.mode === "all_archived") {
        if (!selectedAgentId) return;
        const [normal, archived] = await Promise.all([
          api.listSessions(selectedAgentId),
          api.listSessions(selectedAgentId, true),
        ]);
        setSessions(normal.sessions);
        setArchivedSessions(archived.sessions);
        setSessionBulkPreview(undefined);
        sessionSyncRef.current?.notify();
        if (preview.action === "delete" && activeArchivedSession) enterDraft();
        return;
      }
      const removedIds = new Set(preview.target.sessionIds);
      setSessions((current) => current.filter((item) => !removedIds.has(item.id)));
      sessionSyncRef.current?.notify();
      if (session?.id && removedIds.has(session.id)) {
        enterDraft();
      } else {
        cancelSessionSelection();
      }
    } catch (reason) {
      setSessionBulkPreview(undefined);
      await reportFailure(reason, "执行会话批量操作");
    } finally {
      setSessionBulkBusy(false);
    }
  };

  const showArchivedSessions = async () => {
    setArchiveDialogOpen(true);
    try {
      if (!selectedAgentId) return;
      const result = await api.listSessions(selectedAgentId, true);
      setArchivedSessions(result.sessions);
    } catch (reason) {
      await reportFailure(reason, "加载归档会话");
    }
  };

  const restoreConversation = async (sessionId: string) => {
    try {
      await api.unarchiveSession(sessionId);
      if (!selectedAgentId) return;
      const [normal, archived] = await Promise.all([api.listSessions(selectedAgentId), api.listSessions(selectedAgentId, true)]);
      setSessions(normal.sessions);
      setArchivedSessions(archived.sessions);
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "恢复会话");
    }
  };

  const openArchivedConversation = async (sessionId: string) => {
    await openConversation(sessionId);
    setArchiveDialogOpen(false);
  };

  const send = async () => {
    const text = draft.trim();
    const files = attachmentItems.flatMap((item) => item.status === "uploaded" && item.workspaceFile ? [item.workspaceFile] : []);
    const references = mergeMessageReferences(draftReferences, files);
    const attachmentBusy = attachmentItems.some((item) => item.status !== "uploaded");
    if ((!text && files.length === 0 && references.length === 0) || streaming || attachmentBusy || !selectedAgentId || !selectedModel) {
      return;
    }
    const branchEntryId = editingEntryId;
    const previousAttachmentItems = attachmentItems;
    try {
      stopSpeech();
      // 分支请求尚未返回前即退出编辑态，避免来源消息持续显示“编辑中”。
      if (branchEntryId) setEditingEntryId(undefined);
      const wasDraft = !session;
      const activeSession = session ?? await createConversation(selectedAgentId);
      if (wasDraft && !isSameModel(activeSession.model, selectedModel)) {
        await api.setModel(activeSession.id, selectedModel.provider, selectedModel.id);
        activeSession.model = selectedModel;
      }
      await stream.ensureOpen();
      setDraft("");
      setDraftReferences([]);
      setAttachmentItems([]);
      setError("");
      setActiveRun({
        runId: `pending-${crypto.randomUUID()}`,
        sessionId: activeSession.id,
        status: "queued",
        startedAt: new Date().toISOString(),
      });
      resumeFollowing();
      const pendingEntry: UserEntry = {
        id: crypto.randomUUID(),
        type: "user",
        text,
        files,
        references,
      };
      const sendingAgentId = activeSession.agentId ?? selectedAgentId;
      const sendingAgent = agents.find((item) => item.profile.id === sendingAgentId);
      autoSpeechEligibilityRef.current = sendingAgent?.profile.ttsProfileId
        && sendingAgent.profile.ttsAutoPlay === true
        ? {
          sessionId: activeSession.id,
          previousTurnId: findLastAgentTurnId(timeline),
        }
        : undefined;
      pendingUserMessageRef.current = createPendingUserMessage(
        activeSession.id,
        pendingEntry,
        timeline,
        branchEntryId,
      );
      setTimeline((current) => reduceTimeline(reduceTimeline(current, {
          type: "user_message",
          id: pendingEntry.id,
          text,
          files,
          references,
        }), { type: "generation_started" }));
      if (wasDraft) {
        setSessions((current) => [{
          id: activeSession.id,
          agentId: activeSession.agentId,
          firstMessage: text || files[0]?.name || "新对话",
          modified: new Date().toISOString(),
          messageCount: 1,
        }, ...current.filter((item) => item.id !== activeSession.id)]);
      }
      if (branchEntryId) {
        const result = await api.sendBranchMessage(activeSession.id, branchEntryId, text, files.map((file) => file.path), draftReferences);
        // 分支发送立刻以服务端导航快照替换旧路径，同时保留本地待发送气泡。
        applySnapshot(result.snapshot, "once");
        setActiveRun(result.run);
      } else {
        setActiveRun(await api.sendMessage(activeSession.id, text, files.map((file) => file.path), draftReferences));
      }
    } catch (reason) {
      autoSpeechEligibilityRef.current = undefined;
      pendingUserMessageRef.current = undefined;
      setActiveRun(undefined);
      setTimeline((current) => reduceTimeline(current, { type: "generation_finished", outcome: "error" }));
      setDraft(text);
      setDraftReferences(draftReferences);
      setAttachmentItems(previousAttachmentItems);
      if (branchEntryId) setEditingEntryId(branchEntryId);
      await reportFailure(reason, branchEntryId ? "编辑并重新发送消息" : "发送消息");
    }
  };

  const uploadFiles = async (files: File[]) => {
    const localItems = files.map((file): AttachmentUploadItem => ({
      localId: crypto.randomUUID(),
      file,
      status: "uploading",
    }));
    setError("");
    setAttachmentItems((current) => [...current, ...localItems]);
    try {
      const uploadAgentId = selectedAgentId;
      if (!uploadAgentId) throw new Error("请先创建并选择 Agent");
      const result = await api.uploadAttachments(uploadAgentId, files);
      if (selectedAgentIdRef.current !== uploadAgentId) return;
      setAttachmentItems((current) => current.map((item) => {
        const index = localItems.findIndex((local) => local.localId === item.localId);
        return index >= 0 ? { ...item, status: "uploaded", workspaceFile: result.files[index] } : item;
      }));
    } catch (reason) {
      if (selectedAgentIdRef.current !== selectedAgentId) return;
      const outcome = await reportFailure(reason, "上传聊天附件");
      const message = outcome.status === "handled" && reason instanceof Error
        ? reason.message
        : "附件上传失败，请检查文件后重试。";
      setAttachmentItems((current) => current.map((item) => localItems.some((local) => local.localId === item.localId)
        ? { ...item, status: "error", error: message }
        : item));
      setError(message);
    }
  };

  /** 让文件选择、粘贴和拖放共享相同的数量与大小限制。 */
  const queueAttachmentFiles = (files: File[]) => {
    const validationError = validateAttachmentSelection(attachmentItems.length, files);
    if (validationError) {
      setError(validationError);
      return;
    }
    void uploadFiles(files);
  };

  const abort = async () => {
    if (!session) return;
    stopSpeech();
    try {
      await api.abort(session.id);
    } catch (reason) {
      await reportFailure(reason, "停止消息生成");
    }
  };

  const changeModel = async (model: ModelSummary) => {
    const generation = ++modelChangeGenerationRef.current;
    const targetSessionId = session?.id;
    setSelectedModel(model);
    if (!targetSessionId) return;
    try {
      // 浏览器和服务端都按 Session 串行化，确保快速连续选择时最后一次选择最终生效。
      const request = modelChangeQueueRef.current
        .catch(() => undefined)
        .then(() => api.setModel(targetSessionId, model.provider, model.id));
      modelChangeQueueRef.current = request.catch(() => undefined);
      await request;
      if (generation !== modelChangeGenerationRef.current || sessionIdRef.current !== targetSessionId) return;
      setSession((current) => current?.id === targetSessionId ? { ...current, model } : current);
    } catch (reason) {
      if (generation !== modelChangeGenerationRef.current || sessionIdRef.current !== targetSessionId) return;
      await reportFailure(reason, "切换会话模型");
    }
  };

  const activeAgentId = session?.agentId ?? selectedAgentId;
  const activeAgent = agents.find((item) => item.profile.id === activeAgentId);
  const noAvailableAgent = agents.length === 0;

  useEffect(() => {
    const profile = activeAgent?.profile;
    const eligibility = autoSpeechEligibilityRef.current;
    const turn = [...timeline].reverse().find((entry) => entry.type === "agent");
    if (!profile?.ttsProfileId
      || profile.ttsAutoPlay !== true
      || !eligibility
      || eligibility.sessionId !== session?.id
      || !turn
      || !activeAgentId) {
      return;
    }
    if (!eligibility.turnId) {
      if (turn.id === eligibility.previousTurnId) {
        return;
      }
      eligibility.turnId = turn.id;
    }
    if (eligibility.turnId !== turn.id) {
      return;
    }
    const text = agentTurnSpeechText(turn);
    if (!text) {
      return;
    }
    const controller = ensureSpeechController(activeAgentId);
    if (profile.ttsStreamPlayback) {
      controller.start(turn.id);
      controller.update(turn.id, text, !streaming);
      if (!streaming) {
        autoSpeechEligibilityRef.current = undefined;
      }
      return;
    }
    if (streaming) {
      return;
    }
    controller.start(turn.id);
    controller.update(turn.id, text, true);
    autoSpeechEligibilityRef.current = undefined;
  }, [activeAgent, activeAgentId, ensureSpeechController, session?.id, streaming, timeline]);

  /** 切换当前消息的手动朗读状态。 */
  const toggleSpeech = (turn: AgentTurn) => {
    if (!activeAgentId || !activeAgent?.profile.ttsProfileId) {
      return;
    }
    if (speechState.messageId === turn.id) {
      stopSpeech();
      return;
    }
    autoSpeechEligibilityRef.current = undefined;
    const text = agentTurnSpeechText(turn);
    if (prepareSpeechSegments(text, true).length === 0) {
      setError("该消息没有可朗读内容。");
      return;
    }
    setError("");
    const controller = ensureSpeechController(activeAgentId);
    controller.start(turn.id);
    controller.update(turn.id, text, true);
  };

  /** 将 Pi 历史用户消息还原到现有编辑器，协议文本由服务端在返回前拆解。 */
  const editHistory = async (entryId: string) => {
    if (!session || streaming || isOpeningSession) return;
    try {
      stopSpeech();
      const result = await api.editSessionBranch(session.id, entryId);
      setEditingEntryId(entryId);
      setDraft(result.draft.text);
      setDraftReferences(result.draft.references);
      setAttachmentItems(result.draft.filePaths.map((path) => {
        const missing = result.draft.missingFilePaths.includes(path);
        const name = path.split("/").at(-1) ?? path;
        return {
          localId: `history-${path}`,
          file: new File([], name),
          status: missing ? "missing" as const : "uploaded" as const,
          ...(missing ? { error: `已失效：${path}` } : { workspaceFile: { path, name, mediaType: "application/octet-stream", size: 0, modifiedAt: "" } }),
        };
      }));
      setError(result.draft.missingFilePaths.length > 0 ? `历史附件已失效：${result.draft.missingFilePaths.join("、")}` : "");
    } catch (reason) {
      await reportFailure(reason, "编辑历史消息");
    }
  };

  /** 退出历史消息编辑态，避免回填草稿被误认为一条普通新消息。 */
  const cancelEditing = () => {
    setEditingEntryId(undefined);
    setDraft("");
    setDraftReferences([]);
    setAttachmentItems([]);
    setError("");
  };

  /** 重新提交 Pi 保存的原始用户 prompt，创建新的同级分支。 */
  const regenerate = async (entryId: string) => {
    if (!session || streaming || isOpeningSession) return;
    const targetSessionId = session.id;
    const sourceEntry = timeline.find((entry): entry is UserEntry => (
      entry.type === "user" && entry.piEntryId === entryId
    ));
    if (!sourceEntry) {
      setError("找不到重新生成所对应的用户消息。");
      return;
    }
    const pendingEntry: UserEntry = {
      id: crypto.randomUUID(),
      type: "user",
      text: sourceEntry.text,
      files: sourceEntry.files,
      references: sourceEntry.references,
    };
    pendingUserMessageRef.current = createPendingUserMessage(
      targetSessionId,
      pendingEntry,
      timeline,
      entryId,
    );
    try {
      stopSpeech();
      const result = await api.regenerateSessionBranch(targetSessionId, entryId);
      if (sessionIdRef.current !== targetSessionId) return;
      applySnapshot(result.snapshot, "once");
      setActiveRun(result.run);
      setError("");
    } catch (reason) {
      if (sessionIdRef.current !== targetSessionId) return;
      const pending = pendingUserMessageRef.current;
      if (pending?.sessionId === targetSessionId && pending.entry.id === pendingEntry.id) {
        pendingUserMessageRef.current = undefined;
      }
      await reportFailure(reason, "重新生成回答");
    }
  };

  /** 切换到历史分支的可渲染叶节点，不触发编辑草稿回填。 */
  const navigateHistory = async (entryId: string) => {
    if (!session || streaming || isOpeningSession) return;
    try {
      stopSpeech();
      const snapshot = await api.navigateSessionBranch(session.id, entryId);
      setEditingEntryId(undefined);
      setDraft("");
      setDraftReferences([]);
      setAttachmentItems([]);
      setError("");
      applySnapshot(snapshot, "once");
    } catch (reason) {
      await reportFailure(reason, "切换会话分支");
    }
  };

  const selectAgent = async (agentId: string) => {
    if (streaming || isOpeningSession) return;
    const generation = ++agentSelectionGenerationRef.current;
    const nextAgent = agents.find((item) => item.profile.id === agentId);
    cacheSelectedAgentId(agentId);
    setSelectedAgentId(agentId);
    setSelectedModel(findAgentModel(nextAgent, models, globalDefaultModel));
    enterDraft();
    try {
      const result = await api.listSessions(agentId);
      if (generation === agentSelectionGenerationRef.current) setSessions(result.sessions);
    } catch (reason) {
      if (generation === agentSelectionGenerationRef.current) {
        await reportFailure(reason, "切换 Agent");
      }
    }
  };

  const saveProfileName = async () => {
    if (!profileRevision || profileSaving) return;
    setProfileSaving(true);
    try {
      const document = await api.updateProfile(profileRevision, profileDisplayName);
      setProfileRevision(document.revision);
      setProfileIdentity(toIdentityPreview(document.profile));
      setProfileDisplayName(document.profile.displayName);
    } catch (reason) {
      await reportFailure(reason, "保存个人资料");
    } finally {
      setProfileSaving(false);
    }
  };

  const uploadProfileAvatar = async (file: File | undefined) => {
    if (!file || !profileRevision || profileSaving) return;
    setProfileSaving(true);
    try {
      const document = await api.uploadProfileAvatar(profileRevision, file);
      setProfileRevision(document.revision);
      setProfileIdentity(toIdentityPreview(document.profile));
    } catch (reason) {
      await reportFailure(reason, "上传个人头像");
    } finally {
      setProfileSaving(false);
    }
  };

  const userNavigationItems = timeline.flatMap((entry) => entry.type === "user" ? [{
    id: entry.id,
    summary: summarizePrompt(entry.text, entry.files.map((file) => file.path)),
    targetId: userMessageDomId(entry.id),
  }] : []);
  const activeAgentEntryId = [...timeline].reverse().find((entry) => entry.type === "agent")?.id;

  return (
    <main className="chat-shell live-chat-shell" {...sidebarSwipe.handlers}>
      <ChatSidebar
        open={sidebarOpen}
        sessions={sessions}
        activeSessionId={session?.id}
        openingSessionId={openingSessionId}
        scrolling={sessionNavScrolling}
        noAvailableAgent={noAvailableAgent}
        streaming={streaming}
        refreshing={refreshingSessions}
        profileIdentity={profileIdentity}
        actionsOpenRequest={sessionActionsOpenRequest}
        selectionMode={sessionSelectionMode}
        selectedSessionIds={selectedSessionIds}
        bulkBusy={sessionBulkBusy}
        swiping={sidebarSwipe.swiping}
        swipeTranslatePercent={sidebarSwipe.translatePercent}
        onClose={closeSidebar}
        onEnterDraft={enterDraft}
        onRefresh={() => void refreshSessions()}
        onScroll={showSessionNavScrollbar}
        onPointerDown={startSessionLongPress}
        onPointerEnd={clearSessionLongPress}
        shouldSuppressOpen={(sessionId) => {
          if (suppressSessionOpenRef.current !== sessionId) return false;
          suppressSessionOpenRef.current = undefined;
          return true;
        }}
        onOpen={(sessionId) => void openConversation(sessionId)}
        onRename={(sessionId, name) => void renameConversation(sessionId, name)}
        onArchive={(sessionId) => void archiveConversation(sessionId)}
        onDelete={(sessionId, confirmBoundTasks) => void deleteConversation(sessionId, false, confirmBoundTasks)}
        onEnterSelection={enterSessionSelection}
        onToggleSelection={toggleSessionSelection}
        onCancelSelection={cancelSessionSelection}
        onBulkArchive={() => void previewSessionBulk("archive")}
        onBulkDelete={() => void previewSessionBulk("delete")}
        onShowArchived={() => void showArchivedSessions()}
        onEditProfile={() => setProfileOpen(true)}
      />

      <section className="chat-workspace">
        <header className="chat-header live-chat-header">
          <div className="chat-header__left">
            <button type="button" className="icon-button mobile-menu" aria-label="打开会话历史" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
            <button type="button" className="chat-workbench-switcher" aria-label="打开工作台导航" onClick={() => {
              closeSidebar();
              window.dispatchEvent(new Event(WORKBENCH_NAVIGATION_TOGGLE_EVENT));
            }}><span>工作台</span><ChevronDown size={14} aria-hidden="true" /></button>
            <div className="chat-title"><strong>{session ? "Agent 对话" : "新对话"}</strong><span>pi SDK · 实时连接</span></div>
          </div>
          <div className="chat-header__actions">
            <AgentModelMenu
              agents={agents}
              selectedAgentId={activeAgentId}
              models={models}
              selectedModel={session?.model ?? selectedModel}
              disabled={streaming || isOpeningSession}
              onSelectAgent={(agentId) => void selectAgent(agentId)}
              onSelectModel={(model) => void changeModel(model)}
            />
            <button
              type="button"
              className="icon-button chat-new-session-button"
              aria-label="新建会话"
              title="新建会话"
              disabled={noAvailableAgent || isOpeningSession}
              onClick={enterDraft}
            >
              <MessageSquarePlus size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <ConversationTimelineView
          timeline={timeline}
          theme={theme}
          activeAgent={activeAgent}
          activeAgentId={activeAgentId}
          noAvailableAgent={noAvailableAgent}
          streaming={streaming}
          opening={isOpeningSession}
          profileIdentity={profileIdentity}
          navigationItems={userNavigationItems}
          activeAgentEntryId={activeAgentEntryId}
          speechEnabled={Boolean(activeAgent?.profile.ttsProfileId)}
          activeSpeechMessageId={speechState.messageId}
          scrollRef={messageScrollRef}
          contentRef={messageContentRef}
          historyState={historyLoader.state}
          historySentinelRef={historyLoader.sentinelRef}
          onRetryHistory={historyLoader.retry}
          onResolved={registerMediaSummary}
          onPreview={openImagePreview}
          onCreateAgent={() => navigateTo({ page: "agents", onboarding: "create" })}
          onToggleSpeech={toggleSpeech}
          editingEntryId={editingEntryId}
          onEditHistory={(entryId) => void editHistory(entryId)}
          onNavigateHistory={(entryId) => void navigateHistory(entryId)}
          onRegenerate={(entryId) => void regenerate(entryId)}
        />

        <footer className="composer-dock">
          {composerError && <p className="live-chat-error" role="alert">{composerError}</p>}
          <div className="composer">
            <ReferenceComposer
              value={draft}
              references={draftReferences}
              disabled={noAvailableAgent || isOpeningSession}
              loadCatalog={() => selectedAgentId ? api.getComposerCatalog(selectedAgentId) : Promise.resolve({ skills: [], commands: [], knowledgeBases: [], workspaceEntries: [] })}
              onChange={setDraft}
              onReferencesChange={setDraftReferences}
              onFilesInput={queueAttachmentFiles}
              onSubmit={() => void send()}
              onCatalogError={setError}
              editingContext={editingEntryId ? <div className="composer-editing-context" role="status">
                <div className="composer-editing-context__heading"><PencilLine size={15} aria-hidden="true" /><span><strong>正在编辑历史消息</strong><small>发送后将创建新分支，原消息不会改动。</small></span></div>
                <p title={editingEntry?.text || draft}>{editingEntry?.text || draft || "历史消息"}</p>
                <button type="button" onClick={cancelEditing}>取消编辑</button>
              </div> : undefined}
              attachmentControl={<AttachmentPickerButton items={attachmentItems} disabled={streaming || isOpeningSession || !selectedAgentId} onFilesSelected={queueAttachmentFiles} onError={setError} />}
              attachmentContent={<AttachmentPicker items={attachmentItems} disabled={streaming || isOpeningSession || !selectedAgentId} showButton={false} onFilesSelected={queueAttachmentFiles} onRemove={(localId) => setAttachmentItems((current) => current.filter((item) => item.localId !== localId))} onError={setError} />}
              bottomControls={<div className="composer-actions"><span /><button type="button" disabled={isOpeningSession || (!streaming && (!selectedAgentId || !selectedModel))} className={streaming ? "send-button is-running" : "send-button"} aria-label={streaming ? "停止生成" : editingEntryId ? "创建分支并发送" : "发送消息"} title={streaming ? "停止生成" : editingEntryId ? "创建分支并发送" : "发送消息"} onClick={() => void (streaming ? abort() : send())}>{streaming ? <CircleStop size={18} /> : <Send size={18} />}</button></div>}
            />
          </div>
          <p>Agent 可以在容器权限范围内读取、修改文件和执行命令。</p>
        </footer>
      </section>
      <ArchivedSessionsDialog
        open={archiveDialogOpen}
        sessions={archivedSessions}
        busy={sessionBulkBusy}
        onClose={() => setArchiveDialogOpen(false)}
        onOpen={openArchivedConversation}
        onRestore={restoreConversation}
        onDelete={(sessionId) => deleteConversation(sessionId, true)}
        onRestoreAll={() => selectedAgentId && void previewSessionBulk("restore", { mode: "all_archived", agentId: selectedAgentId })}
        onDeleteAll={() => selectedAgentId && void previewSessionBulk("delete", { mode: "all_archived", agentId: selectedAgentId })}
      />
      {sessionBulkPreview ? <SessionBulkConfirmationDialog
        preview={sessionBulkPreview}
        busy={sessionBulkBusy}
        onCancel={() => setSessionBulkPreview(undefined)}
        onConfirm={() => void executeSessionBulk()}
      /> : null}
      {previewImage ? <MediaLightbox item={previewImage} images={collectTimelineImages(timeline, mediaSummaries)} agentId={activeAgentId} onClose={() => setPreviewImage(undefined)} /> : null}
      <ProfileDialog
        open={profileOpen}
        displayName={profileDisplayName}
        saving={profileSaving}
        ready={Boolean(profileRevision)}
        onClose={() => setProfileOpen(false)}
        onDisplayNameChange={setProfileDisplayName}
        onAvatarSelected={(file) => void uploadProfileAvatar(file)}
        onSave={() => void saveProfileName()}
      />
    </main>
  );
}

function toIdentityPreview(profile: { displayName: string; avatar?: { kind: "image"; revision: string } }): IdentityPreview {
  return { displayName: profile.displayName, avatarText: profile.displayName.trim().slice(0, 1).toUpperCase() || "A", avatar: profile.avatar };
}

/** 返回发送前最后一个 Agent turn，用于只绑定本次新回答。 */
function findLastAgentTurnId(entries: ConversationEntry[]): string | undefined {
  return entries.findLast((entry) => entry.type === "agent")?.id;
}

/**
 * 按当前会话的时间线顺序收集图片，并去除重复的同一路径附件。
 *
 * @param entries 当前会话消息时间线
 * @param summaries 已解析的附件元数据
 */
function collectTimelineImages(entries: ConversationEntry[], summaries: Record<string, WorkspaceFileSummary>): WorkspaceFileSummary[] {
  const paths = new Set<string>();
  const images: WorkspaceFileSummary[] = [];

  for (const entry of entries) {
    const files = entry.type === "user"
      ? entry.files
      : entry.blocks.flatMap((block) => block.type === "files" ? block.files : []);
    for (const file of files) {
      if (paths.has(file.path)) continue;
      paths.add(file.path);
      const summary = summaries[file.path];
      if (summary?.mediaType.startsWith("image/")) images.push(summary);
    }
  }
  return images;
}

/**
 * 乐观气泡中的上传附件也以文件引用展示，避免等待历史快照后才出现标签。
 */
function mergeMessageReferences(references: AgentReference[], files: WorkspaceFileSummary[]): AgentReference[] {
  const filePaths = new Set(references.flatMap((reference) => reference.type === "file" ? [reference.path] : []));
  return [
    ...references,
    ...files.flatMap((file) => {
      if (filePaths.has(file.path)) return [];
      filePaths.add(file.path);
      return [{ type: "file" as const, path: file.path, kind: "file" as const, name: file.name }];
    }),
  ];
}

/**
 * 读取仅在当前浏览器页面生命周期内有效的 Agent 选择。
 */
function readCachedAgentId(): string | undefined {
  try {
    return window.sessionStorage.getItem(SELECTED_AGENT_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 保存当前页面会话中最后手动选择的 Agent。
 */
function cacheSelectedAgentId(agentId: string): void {
  try {
    window.sessionStorage.setItem(SELECTED_AGENT_STORAGE_KEY, agentId);
  } catch {
    // 浏览器禁用会话存储时保留当前页面的既有交互。
  }
}

/**
 * 清除已不存在 Agent 的缓存，避免后续页面持续命中无效值。
 */
function clearCachedAgentId(): void {
  try {
    window.sessionStorage.removeItem(SELECTED_AGENT_STORAGE_KEY);
  } catch {
    // 浏览器禁用会话存储时无需额外处理。
  }
}

function userMessageDomId(entryId: string): string {
  return `live-user-message-${entryId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function summarizePrompt(text: string, filePaths: string[] = []): string {
  const compact = text.replace(/\s+/g, " ").trim() || filePaths.join("、");
  return compact.length > 48 ? `${compact.slice(0, 48)}…` : compact;
}

/**
 * 优先选择 Agent 已保存的默认模型；未覆盖时沿用全局默认模型。
 */
function findAgentModel(
  agent: AgentProfileDocument | undefined,
  models: ModelSummary[],
  globalDefaultModel?: { provider: string; id: string },
): ModelSummary | undefined {
  const defaultModel = agent?.profile.defaultModel ?? globalDefaultModel;
  return models.find((model) => model.provider === defaultModel?.provider && model.id === defaultModel.id) ?? models[0];
}

/**
 * 判断两个模型是否指向同一运行时配置，避免新会话重复写入其默认模型。
 */
function isSameModel(left: ModelSummary | undefined, right: ModelSummary | undefined): boolean {
  return left?.provider === right?.provider && left?.id === right?.id;
}
