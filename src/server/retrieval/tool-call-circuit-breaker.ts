import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type ToolCallArgumentState = "missing" | "empty_object" | "malformed" | "valid";

/** 工具空参数诊断，只包含定位字段和稳定状态，不携带参数正文。 */
export interface ToolCallCircuitBreakerDiagnostic {
  sessionId: string;
  provider?: string;
  model?: string;
  toolName: string;
  argumentState: Exclude<ToolCallArgumentState, "valid">;
  count: number;
  action: "allowed" | "terminated";
}

/** 隐藏的 BugPaw Runtime 扩展定义。 */
export interface ToolCallCircuitBreakerExtension {
  name: string;
  hidden: true;
  factory: ExtensionFactory;
}

const CIRCUIT_BREAK_REASON = "同一工具连续三次缺少有效参数，已终止当前运行；请在下一条消息中重试。";

/** 将模型生成的工具参数归一为不含正文的诊断状态。 */
export function classifyToolCallArguments(input: unknown): ToolCallArgumentState {
  if (input === undefined || input === null) return "missing";
  if (typeof input !== "object" || Array.isArray(input)) return "malformed";
  return Object.keys(input).length === 0 ? "empty_object" : "valid";
}

/** 创建限制同一 Run 内连续空参数调用的隐藏扩展。 */
export function createToolCallCircuitBreakerExtension(
  tools: readonly ToolDefinition[],
  onDiagnostic: (event: ToolCallCircuitBreakerDiagnostic) => void = () => undefined,
): ToolCallCircuitBreakerExtension {
  const guardedTools = new Set(tools.filter((tool) => {
    const required = (tool.parameters as { required?: unknown }).required;
    return Array.isArray(required) && required.length > 0;
  }).map((tool) => tool.name));

  return {
    name: "bug-paw-tool-call-circuit-breaker",
    hidden: true,
    factory: (pi) => {
      let previous: {
        toolName: string;
        state: Exclude<ToolCallArgumentState, "valid">;
        count: number;
      } | undefined;

      pi.on("before_agent_start", () => {
        previous = undefined;
      });
      pi.on("tool_call", (event, ctx) => {
        const state = classifyToolCallArguments(event.input);
        if (!guardedTools.has(event.toolName) || state === "valid") {
          previous = undefined;
          return;
        }
        const count = previous?.toolName === event.toolName && previous.state === state
          ? previous.count + 1
          : 1;
        previous = { toolName: event.toolName, state, count };
        const action = count >= 3 ? "terminated" : "allowed";
        onDiagnostic({
          sessionId: ctx.sessionManager.getSessionId(),
          ...(ctx.model?.provider ? { provider: ctx.model.provider } : {}),
          ...(ctx.model?.id ? { model: ctx.model.id } : {}),
          toolName: event.toolName,
          argumentState: state,
          count,
          action,
        });
        if (count < 3) return;

        // terminate 受同批其他工具结果影响，abort 才能保证只结束当前 Agent Run。
        ctx.abort();
        return { block: true, reason: CIRCUIT_BREAK_REASON, terminate: true };
      });
    },
  };
}
