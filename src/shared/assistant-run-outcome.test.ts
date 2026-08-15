import { describe, expect, it } from "vitest";

import {
  MODEL_REQUEST_FAILED_MESSAGE,
  MODEL_RESPONSE_TRUNCATED_MESSAGE,
  classifyAssistantRunOutcome,
} from "./assistant-run-outcome";

describe("Assistant 运行终止状态", () => {
  it("将最终模型错误分类为安全失败", () => {
    expect(classifyAssistantRunOutcome([{
      role: "assistant",
      stopReason: "error",
      errorMessage: "Bearer clearly-fake-token",
    }])).toEqual({ status: "error", message: MODEL_REQUEST_FAILED_MESSAGE });
  });

  it("区分用户中止与长度截断", () => {
    expect(classifyAssistantRunOutcome([{
      role: "assistant",
      stopReason: "aborted",
    }])).toEqual({ status: "aborted" });
    expect(classifyAssistantRunOutcome([{
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: "partial answer" }],
    }])).toEqual({ status: "completed", notice: MODEL_RESPONSE_TRUNCATED_MESSAGE });
  });

  it.each(["stop", "toolUse", "future-reason"])("将 %s 保持为完成状态", (stopReason) => {
    expect(classifyAssistantRunOutcome([{ role: "assistant", stopReason }])).toEqual({ status: "completed" });
  });

  it("跳过非会话消息并读取最终 Assistant", () => {
    expect(classifyAssistantRunOutcome([
      { role: "assistant", stopReason: "error" },
      { role: "toolResult", content: [] },
      { role: "custom", customType: "checkpoint" },
    ])).toEqual({ status: "error", message: "模型请求失败" });
  });

  it("最新 user 开始新一轮时不复用上一轮错误", () => {
    expect(classifyAssistantRunOutcome([
      { role: "assistant", stopReason: "error" },
      { role: "user", content: "retry" },
      { role: "toolResult", content: [] },
    ])).toEqual({ status: "completed" });
  });

  it("无消息和损坏消息保持完成状态", () => {
    expect(classifyAssistantRunOutcome([])).toEqual({ status: "completed" });
    expect(classifyAssistantRunOutcome([null, "broken", { role: 42 }])).toEqual({ status: "completed" });
  });
});
