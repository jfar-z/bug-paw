import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

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

/** Runtime 工具开始事件中供断路器判断的最小字段。 */
export interface ToolCallCircuitBreakerInput {
  sessionId: string;
  provider?: string;
  model?: string;
  toolName: string;
  args: unknown;
}

/** 每个已打开会话独占一个实例，并在新 Run 开始时重置。 */
export interface ToolCallCircuitBreaker {
  reset(): void;
  observe(input: ToolCallCircuitBreakerInput): { terminate: boolean };
}

/** 将模型生成的工具参数归一为不含正文的诊断状态。 */
export function classifyToolCallArguments(input: unknown): ToolCallArgumentState {
  if (input === undefined || input === null) return "missing";
  if (typeof input !== "object" || Array.isArray(input)) return "malformed";
  return Object.keys(input).length === 0 ? "empty_object" : "valid";
}

/** 创建作用于 SDK Schema 校验之前工具开始事件的断路器。 */
export function createToolCallCircuitBreaker(
  tools: readonly ToolDefinition[],
  onDiagnostic: (event: ToolCallCircuitBreakerDiagnostic) => void = () => undefined,
): ToolCallCircuitBreaker {
  const guardedTools = new Set(tools.filter((tool) => {
    const required = (tool.parameters as { required?: unknown }).required;
    return Array.isArray(required) && required.length > 0;
  }).map((tool) => tool.name));
  let previous: {
    toolName: string;
    state: Exclude<ToolCallArgumentState, "valid">;
    count: number;
  } | undefined;

  return {
    reset() {
      previous = undefined;
    },
    observe(input) {
      const state = classifyToolCallArguments(input.args);
      if (!guardedTools.has(input.toolName) || state === "valid") {
        previous = undefined;
        return { terminate: false };
      }
      const count = previous?.toolName === input.toolName && previous.state === state
        ? previous.count + 1
        : 1;
      previous = { toolName: input.toolName, state, count };
      const action = count >= 3 ? "terminated" : "allowed";
      onDiagnostic({
        sessionId: input.sessionId,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.model ? { model: input.model } : {}),
        toolName: input.toolName,
        argumentState: state,
        count,
        action,
      });
      return { terminate: count >= 3 };
    },
  };
}
