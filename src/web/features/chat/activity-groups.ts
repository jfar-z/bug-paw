import type { AgentBlock, ThinkingBlock, ToolBlock } from "../../conversation-timeline";

export type ActivityBlock = ThinkingBlock | ToolBlock;

export type TurnDisplayItem =
  | { type: "block"; id: string; block: Exclude<AgentBlock, ActivityBlock> }
  | { type: "question"; id: string; tool: ToolBlock }
  | { type: "activity"; id: string; blocks: ActivityBlock[] };

/** 将 Agent 块派生为供聊天视图渲染的普通块与活动段。 */
export function groupAgentBlocks(blocks: readonly AgentBlock[]): TurnDisplayItem[] {
  const items: TurnDisplayItem[] = [];
  let activity: ActivityBlock[] = [];

  const flushActivity = () => {
    if (activity.length === 0) return;
    const first = activity[0];
    const last = activity.at(-1)!;
    items.push({ type: "activity", id: `activity-${first.id}-${last.id}`, blocks: activity });
    activity = [];
  };

  blocks.forEach((block) => {
    if (block.type === "tool" && block.name === "ask_user") {
      flushActivity();
      items.push({ type: "question", id: block.id, tool: block });
      return;
    }
    if (block.type === "thinking" || block.type === "tool") {
      activity.push(block);
      return;
    }
    flushActivity();
    items.push({ type: "block", id: block.id, block });
  });
  flushActivity();
  return items;
}
