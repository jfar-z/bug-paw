import { Archive, Clock3, MessageSquare, MessageSquarePlus, RefreshCw, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from "react";

import type { SessionSummary } from "../../../api";
import type { IdentityPreview } from "../../../pages/chat-page";
import { SessionActionsMenu } from "../../../components/session-actions-menu";
import { UserAvatar } from "./user-avatar";

interface ChatSidebarProps {
  open: boolean;
  sessions: SessionSummary[];
  activeSessionId?: string;
  openingSessionId?: string;
  scrolling: boolean;
  noAvailableAgent: boolean;
  streaming: boolean;
  refreshing: boolean;
  profileIdentity: IdentityPreview;
  actionsOpenRequest?: { sessionId: string; requestId: number };
  selectionMode: boolean;
  selectedSessionIds: string[];
  bulkBusy?: boolean;
  swipeTranslatePercent?: number;
  swiping?: boolean;
  onClose(): void;
  onEnterDraft(): void;
  onRefresh(): void;
  onScroll(): void;
  onPointerDown(sessionId: string, event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerEnd(): void;
  onOpen(sessionId: string): void;
  shouldSuppressOpen(sessionId: string): boolean;
  onRename(sessionId: string, name: string): void;
  onArchive(sessionId: string): void;
  onDelete(sessionId: string, deleteScheduledTasks: boolean): void;
  onEnterSelection(sessionId: string): void;
  onToggleSelection(sessionId: string): void;
  onCancelSelection(): void;
  onBulkArchive(): void;
  onBulkDelete(): void;
  onShowArchived(): void;
  onEditProfile(): void;
}

/** 会话侧栏仅负责展示与手势转发，不持有请求或领域状态。 */
export function ChatSidebar(props: ChatSidebarProps) {
  const isOpeningSession = props.openingSessionId !== undefined;
  const pullStartYRef = useRef<number | undefined>(undefined);
  const [pullDistance, setPullDistance] = useState(0);
  const refreshReady = pullDistance >= 64;

  /** 仅在列表滚动到顶部时记录移动端下拉手势。 */
  function startPullToRefresh(event: ReactTouchEvent<HTMLElement>) {
    if (props.refreshing || event.currentTarget.scrollTop > 0) return;
    pullStartYRef.current = event.touches[0]?.clientY;
  }

  /** 记录下拉距离，为释放刷新提供轻量视觉反馈。 */
  function trackPullToRefresh(event: ReactTouchEvent<HTMLElement>) {
    if (pullStartYRef.current === undefined) return;
    const distance = Math.max(0, (event.touches[0]?.clientY ?? pullStartYRef.current) - pullStartYRef.current);
    setPullDistance(Math.min(distance, 88));
  }

  /** 下拉达到阈值后刷新，普通滚动不会触发列表请求。 */
  function finishPullToRefresh() {
    if (refreshReady && !props.refreshing) props.onRefresh();
    pullStartYRef.current = undefined;
    setPullDistance(0);
  }

  return <>
    {props.open && <button type="button" className="sidebar-scrim" aria-label="关闭会话侧栏" onClick={props.onClose} />}
    <aside
      aria-label="会话历史"
      className={`chat-sidebar${props.open ? " is-open" : ""}${props.swiping ? " is-swiping" : ""}`}
      style={props.swipeTranslatePercent === undefined ? undefined : { transform: `translateX(${props.swipeTranslatePercent}%)` }}
    >
      <div className="sidebar-header live-session-header"><div><span>{props.selectionMode ? `已选 ${props.selectedSessionIds.length} 项` : "会话"}</span><small>{props.selectionMode ? "SELECT SESSIONS" : "SESSIONS"}</small></div><button type="button" className="session-refresh-button" aria-label="刷新会话列表" title="刷新会话列表" disabled={props.refreshing || isOpeningSession || props.selectionMode} onClick={props.onRefresh}><RefreshCw size={15} aria-hidden="true" className={props.refreshing ? "is-spinning" : undefined} /></button></div>
      <button type="button" className="new-chat-button" onClick={props.onEnterDraft} disabled={props.noAvailableAgent || isOpeningSession || props.selectionMode}>
        <MessageSquarePlus size={18} aria-hidden="true" /><span>新对话</span>
      </button>
      <nav className={`session-nav${props.scrolling ? " is-scrolling" : ""}${pullDistance > 0 ? " is-pulling" : ""}`} aria-label="会话历史" onScroll={props.onScroll} onTouchStart={startPullToRefresh} onTouchMove={trackPullToRefresh} onTouchEnd={finishPullToRefresh} onTouchCancel={finishPullToRefresh}>
        {pullDistance > 0 ? <div className="session-refresh-hint" aria-live="polite" style={{ height: pullDistance }}><RefreshCw size={14} aria-hidden="true" className={refreshReady ? "is-ready" : undefined} /><span>{refreshReady ? "松开刷新" : "下拉刷新"}</span></div> : null}
        <p>最近</p>
        {props.sessions.map((item) => {
          const title = item.name || item.firstMessage || "新对话";
          const selectionDisabled = isOpeningSession || (props.streaming && item.id === props.activeSessionId);
          return (
          <div className={`session-row${item.id === props.activeSessionId ? " is-active" : ""}${item.id === props.openingSessionId ? " is-opening" : ""}`} key={item.id}>
            {props.selectionMode ? <label className={`session-row__select${selectionDisabled ? " is-disabled" : ""}`}>
              <input
                type="checkbox"
                aria-label={`选择 ${title}`}
                checked={props.selectedSessionIds.includes(item.id)}
                disabled={selectionDisabled}
                onChange={() => props.onToggleSelection(item.id)}
              />
              <MessageSquare size={16} aria-hidden="true" />
              <span>{title}</span>
              {props.streaming && item.id === props.activeSessionId ? <small>生成中</small> : null}
              {item.scheduledTaskCount ? <Clock3 size={14} aria-label={`已绑定 ${item.scheduledTaskCount} 个定时任务`} /> : null}
            </label> : <><button
              type="button"
              className="session-row__open"
              disabled={isOpeningSession}
              aria-busy={item.id === props.openingSessionId || undefined}
              onPointerDown={(event) => props.onPointerDown(item.id, event)}
              onPointerUp={props.onPointerEnd}
              onPointerCancel={props.onPointerEnd}
              onPointerLeave={props.onPointerEnd}
              onContextMenu={(event) => event.preventDefault()}
              onClick={() => { if (!props.shouldSuppressOpen(item.id)) props.onOpen(item.id); }}
            >
              <MessageSquare size={16} aria-hidden="true" /><span>{title}</span>{item.scheduledTaskCount ? <Clock3 size={14} aria-label={`已绑定 ${item.scheduledTaskCount} 个定时任务`} /> : null}
            </button>
            <SessionActionsMenu
              session={item}
              disabled={isOpeningSession || (props.streaming && item.id === props.activeSessionId)}
              openRequestId={props.actionsOpenRequest?.sessionId === item.id ? props.actionsOpenRequest.requestId : undefined}
              onRename={(name) => props.onRename(item.id, name)}
              onArchive={() => props.onArchive(item.id)}
              onDelete={(deleteScheduledTasks) => props.onDelete(item.id, deleteScheduledTasks)}
              onSelectMultiple={() => props.onEnterSelection(item.id)}
            />
            </>}
          </div>
        ); })}
      </nav>
      {props.selectionMode ? <div className="session-selection-toolbar" aria-label="会话多选操作">
        <button type="button" aria-label="归档已选会话" disabled={props.selectedSessionIds.length === 0 || props.bulkBusy} onClick={props.onBulkArchive}><Archive size={15} aria-hidden="true" /><span>归档</span></button>
        <button type="button" className="is-danger" aria-label="删除已选会话" disabled={props.selectedSessionIds.length === 0 || props.bulkBusy} onClick={props.onBulkDelete}><Trash2 size={15} aria-hidden="true" /><span>删除</span></button>
        <button type="button" aria-label="取消多选" disabled={props.bulkBusy} onClick={props.onCancelSelection}><X size={15} aria-hidden="true" /><span>取消</span></button>
      </div> : <button type="button" className="archived-chat-button" aria-label="查看已归档会话" disabled={isOpeningSession} onClick={props.onShowArchived}>
        <Archive size={16} aria-hidden="true" /><span>已归档</span>
      </button>}
      <div className="sidebar-footer"><button type="button" className="account-button" aria-label="编辑个人资料" onClick={props.onEditProfile}><UserAvatar identity={props.profileIdentity} className="avatar" /><span><strong>{props.profileIdentity.displayName}</strong><small>本地工作区</small></span></button></div>
    </aside>
  </>;
}
