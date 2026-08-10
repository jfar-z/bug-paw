import { Archive, Clock3, MessageSquare, MessageSquarePlus } from "lucide-react";
import type { PointerEvent as ReactPointerEvent } from "react";

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
  profileIdentity: IdentityPreview;
  actionsOpenRequest?: { sessionId: string; requestId: number };
  onClose(): void;
  onEnterDraft(): void;
  onScroll(): void;
  onPointerDown(sessionId: string, event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerEnd(): void;
  onOpen(sessionId: string): void;
  shouldSuppressOpen(sessionId: string): boolean;
  onRename(sessionId: string, name: string): void;
  onArchive(sessionId: string): void;
  onDelete(sessionId: string, deleteScheduledTasks: boolean): void;
  onShowArchived(): void;
  onEditProfile(): void;
}

/** 会话侧栏仅负责展示与手势转发，不持有请求或领域状态。 */
export function ChatSidebar(props: ChatSidebarProps) {
  const isOpeningSession = props.openingSessionId !== undefined;
  return <>
    {props.open && <button type="button" className="sidebar-scrim" aria-label="关闭会话侧栏" onClick={props.onClose} />}
    <aside aria-label="会话历史" className={props.open ? "chat-sidebar is-open" : "chat-sidebar"}>
      <div className="sidebar-header live-session-header"><span>会话</span><small>SESSIONS</small></div>
      <button type="button" className="new-chat-button" onClick={props.onEnterDraft} disabled={props.noAvailableAgent || isOpeningSession}>
        <MessageSquarePlus size={18} aria-hidden="true" /><span>新对话</span>
      </button>
      <nav className={`session-nav${props.scrolling ? " is-scrolling" : ""}`} aria-label="会话历史" onScroll={props.onScroll}>
        <p>最近</p>
        {props.sessions.map((item) => (
          <div className={`session-row${item.id === props.activeSessionId ? " is-active" : ""}${item.id === props.openingSessionId ? " is-opening" : ""}`} key={item.id}>
            <button
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
              <MessageSquare size={16} aria-hidden="true" /><span>{item.name || item.firstMessage || "新对话"}</span>{item.scheduledTaskCount ? <Clock3 size={14} aria-label={`已绑定 ${item.scheduledTaskCount} 个定时任务`} /> : null}
            </button>
            <SessionActionsMenu
              session={item}
              disabled={isOpeningSession || (props.streaming && item.id === props.activeSessionId)}
              openRequestId={props.actionsOpenRequest?.sessionId === item.id ? props.actionsOpenRequest.requestId : undefined}
              onRename={(name) => props.onRename(item.id, name)}
              onArchive={() => props.onArchive(item.id)}
              onDelete={(deleteScheduledTasks) => props.onDelete(item.id, deleteScheduledTasks)}
            />
          </div>
        ))}
      </nav>
      <button type="button" className="archived-chat-button" aria-label="查看已归档会话" disabled={isOpeningSession} onClick={props.onShowArchived}>
        <Archive size={16} aria-hidden="true" /><span>已归档</span>
      </button>
      <div className="sidebar-footer"><button type="button" className="account-button" aria-label="编辑个人资料" onClick={props.onEditProfile}><UserAvatar identity={props.profileIdentity} className="avatar" /><span><strong>{props.profileIdentity.displayName}</strong><small>本地工作区</small></span></button></div>
    </aside>
  </>;
}
