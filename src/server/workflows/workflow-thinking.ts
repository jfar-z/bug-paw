import { THINKING_LEVELS, type ThinkingLevel } from "../../shared/configuration-contracts";

/** 与聊天区一致，仅公开模型声明支持的思考等级。 */
export function workflowThinkingLevels(model: {
  reasoning: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    return level !== "xhigh" && level !== "max" || mapped !== undefined;
  });
}
