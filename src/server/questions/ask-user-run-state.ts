import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/** 跟踪当前 Run 首个 ask_user，阻止其后的流式内容泄漏到浏览器。 */
export class AskUserRunState {
  private askToolCallId?: string;

  /** 观察流式工具调用起点，仅记录首个 ask_user。 */
  observeToolCallStart(callId: string, toolName: string): void {
    if (!this.askToolCallId && toolName === "ask_user") {
      this.askToolCallId = callId;
    }
  }

  /** 判断 SDK 事件是否仍属于允许公开的首个提问调用。 */
  shouldPublish(event: AgentSessionEvent): boolean {
    if (!this.askToolCallId) return true;
    if (event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "toolcall_start" || assistantEvent.type === "toolcall_delta") {
        return readToolCallId(event.message, assistantEvent.contentIndex) === this.askToolCallId;
      }
      if (assistantEvent.type === "toolcall_end") {
        return assistantEvent.toolCall.id === this.askToolCallId;
      }
      return false;
    }
    if (event.type === "tool_execution_start"
      || event.type === "tool_execution_update"
      || event.type === "tool_execution_end") {
      return event.toolCallId === this.askToolCallId;
    }
    return true;
  }

  /** 工具参数或业务执行失败时解除抑制，让模型可继续纠正。 */
  finishTool(callId: string, isError: boolean): void {
    if (callId === this.askToolCallId && isError) {
      this.reset();
    }
  }

  /** 清理本 Run 的提问状态。 */
  reset(): void {
    this.askToolCallId = undefined;
  }
}

function readToolCallId(message: unknown, contentIndex: number): string | undefined {
  if (!message || typeof message !== "object" || !Array.isArray((message as { content?: unknown }).content)) {
    return undefined;
  }
  const block = (message as { content: unknown[] }).content[contentIndex];
  return block && typeof block === "object" && typeof (block as { id?: unknown }).id === "string"
    ? (block as { id: string }).id
    : undefined;
}
