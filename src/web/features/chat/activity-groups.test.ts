import { describe, expect, it } from "vitest";

import type { AgentBlock, MarkdownBlock, ThinkingBlock, ToolBlock } from "../../conversation-timeline";
import { groupAgentBlocks } from "./activity-groups";

const markdown = (id: string, text: string): MarkdownBlock => ({ id, type: "markdown", text, streaming: false });
const thinking = (id: string, text: string): ThinkingBlock => ({ id, type: "thinking", text, streaming: false });
const tool = (id: string, name: string): ToolBlock => ({
  id,
  type: "tool",
  callId: `call-${id}`,
  name,
  args: undefined,
  status: "completed",
});

describe("聊天活动段分组", () => {
  it("仅合并相邻思考与工具并保持正文分隔顺序", () => {
    const blocks: AgentBlock[] = [
      markdown("m1", "第一段"),
      thinking("t1", "分析"),
      tool("r1", "read"),
      tool("e1", "edit"),
      markdown("m2", "第二段"),
      tool("b1", "bash"),
    ];

    expect(groupAgentBlocks(blocks)).toMatchObject([
      { type: "block", id: "m1", block: { type: "markdown" } },
      { type: "activity", id: "activity-t1-e1", blocks: [{ type: "thinking" }, { type: "tool" }, { type: "tool" }] },
      { type: "block", id: "m2", block: { type: "markdown" } },
      { type: "activity", id: "activity-b1-b1", blocks: [{ type: "tool" }] },
    ]);
  });

  it("不修改输入数组和原始块引用", () => {
    const blocks: AgentBlock[] = [thinking("t1", "分析"), tool("r1", "read")];
    const before = [...blocks];

    const grouped = groupAgentBlocks(blocks);

    expect(blocks).toEqual(before);
    expect(grouped[0]).toMatchObject({ type: "activity" });
    if (grouped[0]?.type === "activity") {
      expect(grouped[0].blocks[0]).toBe(blocks[0]);
      expect(grouped[0].blocks[1]).toBe(blocks[1]);
    }
  });

  it("将提问工具提升为独立卡片并切断相邻活动段", () => {
    const blocks: AgentBlock[] = [thinking("t1", "分析"), tool("ask", "ask_user"), tool("r1", "read")];

    expect(groupAgentBlocks(blocks)).toMatchObject([
      { type: "activity", blocks: [{ id: "t1" }] },
      { type: "question", id: "ask", tool: { name: "ask_user" } },
      { type: "activity", blocks: [{ id: "r1" }] },
    ]);
  });
});
