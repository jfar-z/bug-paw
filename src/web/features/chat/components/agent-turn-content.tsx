import type { AgentTurn, ErrorBlock, MarkdownBlock } from "../../../conversation-timeline";
import type { ThemePreference } from "../../../theme";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { MarkdownContent } from "../../../components/markdown-content";
import { groupAgentBlocks } from "../activity-groups";
import { ActivityGroup, activityGroupAutomaticExpanded } from "./activity-group";
import { QuestionTimelineCard } from "../../../components/question-timeline-card";

interface AgentTurnContentProps {
  turn: AgentTurn;
  streaming: boolean;
  theme: ThemePreference;
  onLinkActivate?(href: string): boolean;
  focusedEntryId?: string;
  actions?: ReactNode;
}

/** 按原始顺序渲染 Agent 正文、附件与派生活动段。 */
export function AgentTurnContent({
  turn,
  streaming,
  theme,
  onLinkActivate,
  focusedEntryId,
  actions,
}: AgentTurnContentProps) {
  const items = useMemo(() => groupAgentBlocks(turn.blocks), [turn.blocks]);
  const [expandedOverrides, setExpandedOverrides] = useState<Record<string, boolean>>({});
  const activityItems = items.filter((item) => item.type === "activity");
  const isExpanded = (item: Extract<(typeof items)[number], { type: "activity" }>, index: number) => expandedOverrides[item.id]
    ?? activityGroupAutomaticExpanded(item.blocks, index === items.length - 1, streaming);
  const anyExpanded = activityItems.some((item) => isExpanded(item, items.indexOf(item)));

  const setAllExpanded = (expanded: boolean) => {
    setExpandedOverrides(Object.fromEntries(activityItems.map((item) => [item.id, expanded])));
  };

  return <>
    {items.map((item, index) => {
      if (item.type === "activity") {
        return <ActivityGroup
          key={item.id}
          id={item.id}
          blocks={item.blocks}
          trailing={index === items.length - 1}
          turnStreaming={streaming}
          expandedOverride={expandedOverrides[item.id]}
          onExpandedChange={(expanded) => setExpandedOverrides((current) => ({ ...current, [item.id]: expanded }))}
        />;
      }
      if (item.type === "question") {
        return <QuestionTimelineCard key={item.id} tool={item.tool} />;
      }
      if (item.block.type === "error") {
        return <AgentErrorBlock key={item.id} block={item.block} />;
      }
      return <MarkdownBlockView key={item.id} block={item.block} theme={theme} onLinkActivate={onLinkActivate} focused={Boolean(focusedEntryId) && item.block.piEntryId === focusedEntryId} />;
    })}
    {activityItems.length > 0 ? <div className="agent-turn-footer message-actions--separated">
      {actions}
      <div className="agent-turn-activity-controls">
        <button type="button" onClick={() => setAllExpanded(!anyExpanded)}>
          {anyExpanded ? "收起本轮全部活动" : "展开本轮全部活动"}
        </button>
      </div>
    </div> : actions}
  </>;
}

/** 在对话原位置展示本轮错误，避免用户只能从全局弹窗判断生成状态。 */
function AgentErrorBlock({ block }: { block: ErrorBlock }) {
  return <div className="configuration-inline-error" role="alert">
    <strong>{block.code}</strong>
    <p>{block.message}</p>
  </div>;
}

function MarkdownBlockView({ block, theme, onLinkActivate, focused }: { block: MarkdownBlock; theme: ThemePreference; onLinkActivate?: (href: string) => boolean; focused: boolean }) {
  return <MarkdownContent
    text={block.text}
    sessionEntryId={block.piEntryId}
    focused={focused}
    streaming={block.streaming}
    revealStart={block.revealStart}
    revealPhase={block.revealPhase}
    theme={theme}
    onLinkActivate={onLinkActivate}
  />;
}
