import { Clock3, Pencil, RefreshCcw } from "lucide-react";
import type { RefObject } from "react";

import type { AgentProfileDocument } from "../../../../shared/agent-contracts";
import type { WorkspaceFileSummary } from "../../../../shared/contracts";
import { AgentAvatar } from "../../../components/agent-avatar";
import { AgentReferenceChips } from "../../../components/agent-reference-chips";
import { LiveToolCard } from "../../../components/live-tool-card";
import { MarkdownContent } from "../../../components/markdown-content";
import { MessageAttachments } from "../../../components/message-attachments";
import { MessageNavigator } from "../../../components/message-navigator";
import { ThinkingCard } from "../../../components/thinking-card";
import type { AgentTurn, ConversationEntry } from "../../../conversation-timeline";
import type { IdentityPreview } from "../../../pages/chat-page";
import { agentTurnSpeechText, prepareSpeechSegments } from "../../../speech-text";
import type { ThemePreference } from "../../../theme";
import { UserAvatar } from "./user-avatar";
import { MessageSpeechButton } from "./message-speech-button";

interface ConversationTimelineViewProps {
  timeline: ConversationEntry[];
  theme: ThemePreference;
  activeAgent?: AgentProfileDocument;
  activeAgentId?: string;
  noAvailableAgent: boolean;
  streaming: boolean;
  opening: boolean;
  profileIdentity: IdentityPreview;
  navigationItems: Array<{ id: string; summary: string; targetId: string }>;
  activeAgentEntryId?: string;
  speechEnabled: boolean;
  activeSpeechMessageId?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  onResolved(summary: WorkspaceFileSummary): void;
  onPreview(summary: WorkspaceFileSummary): void;
  onCreateAgent(): void;
  onToggleSpeech(turn: AgentTurn): void;
  onEditHistory?(entryId: string): void;
  onRegenerate?(entryId: string): void;
}

/** 渲染会话时间线，保持既有 DOM 顺序、ARIA 与流式块语义。 */
export function ConversationTimelineView(props: ConversationTimelineViewProps) {
  return <>
    <MessageNavigator items={props.navigationItems} scrollContainerRef={props.scrollRef} />
    <div className="message-scroll" ref={props.scrollRef} style={{ scrollbarGutter: "stable" }}>
      <div className="message-column message-column--compact-end" ref={props.contentRef}>
        {props.timeline.length === 0 && <div className="session-intro">
          {props.activeAgent ? <AgentAvatar agent={props.activeAgent} className="agent-orbit session-intro__agent-avatar" label={`${props.activeAgent.profile.name} 头像`} /> : <span className="agent-orbit">?</span>}
          <h1>{props.activeAgent?.profile.name ?? "从这里开始协作。"}</h1>
          {props.noAvailableAgent ? <><p>请先在 Agent 管理中创建 Agent，再开始对话。</p><button type="button" className="configuration-primary-action session-intro__create-agent" onClick={props.onCreateAgent}>创建 Agent</button></> : <p>{props.activeAgent?.profile.description?.trim() || `准备好后，向 ${props.activeAgent?.profile.name ?? "你的 Agent"} 发出第一条消息，开始推进你的工作。`}</p>}
        </div>}
        {props.timeline.map((entry) => entry.type === "user" ? (
          <article className={`message-row is-user${entry.source === "scheduled" ? " is-scheduled" : ""}`} id={userMessageDomId(entry.id)} key={entry.id}>
            <div className="message-meta">
              <strong>{entry.source === "scheduled" ? "定时任务" : props.profileIdentity.displayName}</strong>
              {entry.source === "scheduled" ? <span className="message-avatar is-scheduled-avatar" aria-label="定时任务消息"><Clock3 size={15} aria-hidden="true" /></span> : <UserAvatar identity={props.profileIdentity} className="message-avatar is-user-avatar" />}
            </div>
            <div className="message-content">
              {entry.text && <p>{entry.text}</p>}
              <AgentReferenceChips references={entry.references} />
              {entry.files.length > 0 && props.activeAgentId && <MessageAttachments files={entry.files} agentId={props.activeAgentId} onResolved={props.onResolved} onPreview={props.onPreview} />}
              {entry.piEntryId && entry.source !== "scheduled" ? <div className="message-actions user-message-actions" aria-label="用户消息操作"><button type="button" aria-label="重新编辑消息" title="重新编辑消息" disabled={props.streaming || props.opening} onClick={() => props.onEditHistory?.(entry.piEntryId!)}><Pencil size={15} aria-hidden="true" /></button></div> : null}
            </div>
          </article>
        ) : (
          <article className="message-row is-assistant" key={entry.id}>
            <div className="message-meta">
              {props.activeAgent ? <AgentAvatar agent={props.activeAgent} className="message-avatar is-agent-avatar" label={`${props.activeAgent.profile.name}头像`} /> : <span className="message-avatar is-agent-avatar">?</span>}
              <strong>{props.activeAgent?.profile.name ?? "已删除 Agent"}</strong>
              {props.streaming && entry.id === props.activeAgentEntryId && <span className="agent-run-indicator" aria-label="Agent 正在处理" />}
            </div>
            <div className="message-content">
              {entry.blocks.map((block) => {
                if (block.type === "markdown") return <MarkdownContent key={block.id} text={block.text} streaming={block.streaming} revealStart={block.revealStart} revealPhase={block.revealPhase} theme={props.theme} />;
                if (block.type === "thinking") return <ThinkingCard key={block.id} thinking={block} />;
                if (block.type === "files") return props.activeAgentId ? <MessageAttachments key={block.id} files={block.files} agentId={props.activeAgentId} onResolved={props.onResolved} onPreview={props.onPreview} /> : null;
                return <LiveToolCard key={block.id} tool={block} />;
              })}
              {props.speechEnabled && agentTurnSpeechText(entry) ? (
                <div className="message-actions message-actions--speech message-actions--separated" aria-label="Agent 消息操作">
                  {entry.sourceUserEntryId ? <button type="button" aria-label="重新生成回答" title="重新生成回答" disabled={props.streaming || props.opening} onClick={() => props.onRegenerate?.(entry.sourceUserEntryId!)}><RefreshCcw size={16} aria-hidden="true" /></button> : null}
                  <MessageSpeechButton
                    active={props.activeSpeechMessageId === entry.id}
                    disabled={speechButtonDisabled(entry, props.streaming, props.activeAgentEntryId)}
                    onToggle={() => props.onToggleSpeech(entry)}
                  />
                </div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {props.opening ? <div className="session-loading-overlay" role="status" aria-label="正在加载会话"><span aria-hidden="true" />正在加载会话…</div> : null}
    </div>
  </>;
}

function userMessageDomId(entryId: string): string {
  return `live-user-message-${entryId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** 流式正文尚未形成稳定语音片段时暂不允许手动朗读。 */
function speechButtonDisabled(turn: AgentTurn, streaming: boolean, activeAgentEntryId?: string): boolean {
  if (!streaming || turn.id !== activeAgentEntryId) {
    return false;
  }
  return prepareSpeechSegments(agentTurnSpeechText(turn), false).length === 0;
}
