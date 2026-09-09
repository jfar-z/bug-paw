import { describe, expect, it } from "vitest";

import { parsePiHistory, reduceTimeline, type ConversationEntry } from "./conversation-timeline";

/** 对话错误必须在实时与历史时间线中保持可见。 */
describe("conversation timeline errors", () => {
  it("把实时生成错误附加到当前 Agent 回合", () => {
    const started = reduceTimeline([], { type: "generation_started" });
    const finished = reduceTimeline(started, {
      type: "generation_finished",
      outcome: "error",
      error: { code: "AGENT_EXECUTION_FAILED", message: "Provider 返回 HTTP 429" },
    });
    expect(errorBlocks(finished)).toEqual([
      expect.objectContaining({ code: "AGENT_EXECUTION_FAILED", message: "Provider 返回 HTTP 429" }),
    ]);
  });

  it("从历史 Assistant 消息恢复错误块", () => {
    const timeline = parsePiHistory([{ role: "assistant", content: [], stopReason: "error", errorMessage: "Provider 返回 HTTP 401" }]);
    expect(errorBlocks(timeline)).toEqual([
      expect.objectContaining({ code: "AGENT_EXECUTION_FAILED", message: "Provider 返回 HTTP 401" }),
    ]);
  });
});

/** 收集 Agent 回合中的错误块。 */
function errorBlocks(entries: ConversationEntry[]) {
  return entries.flatMap((entry) => entry.type === "agent" ? entry.blocks.filter((block) => block.type === "error") : []);
}
