import { Check } from "typebox/value";

import { QuestionResolutionSchema, type QuestionResolution } from "../../shared/question-response-protocol";
import { PendingQuestionProjectionSchema, type PendingQuestionProjection } from "../../shared/session-question-contracts";
import type { ToolBlock } from "../conversation-timeline";

interface QuestionTimelineCardProps {
  tool: ToolBlock;
}

/** 在聊天历史中安全展示提问结果，不回显原始工具参数和内部详情。 */
export function QuestionTimelineCard({ tool }: QuestionTimelineCardProps) {
  const state = readQuestionState(tool);
  if (!state.pending) {
    // 工具进行中时问题详情可能尚未随流事件到达，这属于正常创建过程。
    if (tool.status === "preparing" || tool.status === "parameterizing" || tool.status === "running") {
      return <section className="question-timeline-card" aria-label="提问状态">
        <strong>正在创建提问</strong>
        <span>Agent 正在准备问题，请稍候。</span>
      </section>;
    }
    return <section className="question-timeline-card is-error" aria-label="提问状态">
      <strong>提问未能创建</strong>
      <span>请继续对话或重新发起提问。</span>
    </section>;
  }

  const { pending, resolution } = state;
  return <section className="question-timeline-card" aria-label="提问状态">
    <header>
      <strong>{resolution?.status === "submitted"
        ? "已回答"
        : resolution?.status === "discarded"
          ? "已放弃"
          : "等待回答"}</strong>
      <span>共 {pending.questions.length} 个问题</span>
    </header>
  </section>;
}

function readQuestionState(tool: ToolBlock): {
  pending?: PendingQuestionProjection;
  resolution?: QuestionResolution;
} {
  if (!isRecord(tool.details)) return {};
  const pending = Check(PendingQuestionProjectionSchema, tool.details.pendingQuestion)
    ? tool.details.pendingQuestion
    : undefined;
  const resolution = Check(QuestionResolutionSchema, tool.details.resolution)
    ? tool.details.resolution
    : undefined;
  return { pending, resolution };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
