// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  classifyToolCallArguments,
  createToolCallCircuitBreakerExtension,
  type ToolCallCircuitBreakerDiagnostic,
  type ToolCallCircuitBreakerExtension,
} from "./tool-call-circuit-breaker";

describe("工具空参数断路器", () => {
  it("前两次空对象放行，第三次阻止并 abort 当前 Run", async () => {
    const abort = vi.fn();
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const handlers = register(createToolCallCircuitBreakerExtension([
      requiredActionTool("knowledge_manage"),
    ], (event) => diagnostics.push(event)));
    const ctx = context(abort);
    await handlers.beforeAgentStart({ type: "before_agent_start" }, ctx);

    expect(await handlers.toolCall(emptyCall("knowledge_manage"), ctx)).toBeUndefined();
    expect(await handlers.toolCall(emptyCall("knowledge_manage"), ctx)).toBeUndefined();
    expect(await handlers.toolCall(emptyCall("knowledge_manage"), ctx)).toEqual({
      block: true,
      reason: "同一工具连续三次缺少有效参数，已终止当前运行；请在下一条消息中重试。",
      terminate: true,
    });

    expect(abort).toHaveBeenCalledOnce();
    expect(diagnostics.map(({ count, action }) => ({ count, action }))).toEqual([
      { count: 1, action: "allowed" },
      { count: 2, action: "allowed" },
      { count: 3, action: "terminated" },
    ]);
  });

  it("新的 Run 会清除之前的连续计数", async () => {
    const handlers = register(createToolCallCircuitBreakerExtension([requiredActionTool("knowledge_manage")]));
    const ctx = context(vi.fn());
    await handlers.beforeAgentStart({ type: "before_agent_start" }, ctx);
    await handlers.toolCall(emptyCall("knowledge_manage"), ctx);
    await handlers.toolCall(emptyCall("knowledge_manage"), ctx);

    await handlers.beforeAgentStart({ type: "before_agent_start" }, ctx);

    expect(await handlers.toolCall(emptyCall("knowledge_manage"), ctx)).toBeUndefined();
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("有效参数或其他工具会打断连续空调用", async () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const handlers = register(createToolCallCircuitBreakerExtension([
      requiredActionTool("knowledge_manage"),
      requiredActionTool("knowledge_read"),
    ], (event) => diagnostics.push(event)));
    const ctx = context(vi.fn());
    await handlers.beforeAgentStart({ type: "before_agent_start" }, ctx);
    await handlers.toolCall(emptyCall("knowledge_manage"), ctx);
    await handlers.toolCall(emptyCall("knowledge_manage"), ctx);
    await handlers.toolCall({ ...emptyCall("knowledge_manage"), input: { action: "list_bases" } }, ctx);
    await handlers.toolCall(emptyCall("knowledge_manage"), ctx);
    await handlers.toolCall(emptyCall("knowledge_read"), ctx);
    await handlers.toolCall(emptyCall("knowledge_manage"), ctx);

    expect(diagnostics.map(({ toolName, count }) => ({ toolName, count }))).toEqual([
      { toolName: "knowledge_manage", count: 1 },
      { toolName: "knowledge_manage", count: 2 },
      { toolName: "knowledge_manage", count: 1 },
      { toolName: "knowledge_read", count: 1 },
      { toolName: "knowledge_manage", count: 1 },
    ]);
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("没有必填字段的工具不进入断路计数", async () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const handlers = register(createToolCallCircuitBreakerExtension([
      { ...requiredActionTool("optional_tool"), parameters: { type: "object", properties: {} } },
    ], (event) => diagnostics.push(event)));
    const ctx = context(vi.fn());

    expect(await handlers.toolCall(emptyCall("optional_tool"), ctx)).toBeUndefined();
    expect(diagnostics).toEqual([]);
    expect(ctx.abort).not.toHaveBeenCalled();
  });

  it("稳定分类缺失、空对象、畸形与有效参数", () => {
    expect(classifyToolCallArguments(undefined)).toBe("missing");
    expect(classifyToolCallArguments(null)).toBe("missing");
    expect(classifyToolCallArguments({})).toBe("empty_object");
    expect(classifyToolCallArguments([])).toBe("malformed");
    expect(classifyToolCallArguments("bad")).toBe("malformed");
    expect(classifyToolCallArguments({ action: "list_bases" })).toBe("valid");
  });

  it("诊断只包含枚举状态，不包含原始参数正文", async () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const handlers = register(createToolCallCircuitBreakerExtension([
      requiredActionTool("knowledge_manage"),
    ], (event) => diagnostics.push(event)));
    const ctx = context(vi.fn());

    await handlers.toolCall({ ...emptyCall("knowledge_manage"), input: "private-value" }, ctx);

    expect(diagnostics).toEqual([{
      sessionId: "session-1",
      provider: "local",
      model: "qwen-test",
      toolName: "knowledge_manage",
      argumentState: "malformed",
      count: 1,
      action: "allowed",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private-value");
  });
});

type EventHandler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

/** 执行真实扩展工厂并捕获两个业务事件处理器。 */
function register(extension: ToolCallCircuitBreakerExtension) {
  const handlers = new Map<string, EventHandler>();
  extension.factory({
    on: (type: string, handler: EventHandler) => {
      handlers.set(type, handler);
    },
  } as never);
  return {
    beforeAgentStart: handlers.get("before_agent_start") as EventHandler,
    toolCall: handlers.get("tool_call") as EventHandler,
  };
}

/** 创建声明 action 必填的最小工具定义。 */
function requiredActionTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: "测试工具",
    parameters: {
      type: "object",
      properties: { action: { type: "string" } },
      required: ["action"],
    },
    execute: vi.fn(),
  } as never;
}

/** 创建空对象工具调用事件。 */
function emptyCall(toolName: string) {
  return { type: "tool_call", toolName, toolCallId: "call-1", input: {} };
}

/** 创建只暴露断路器所需能力的 Extension Context。 */
function context(abort: ReturnType<typeof vi.fn>) {
  return {
    abort,
    sessionManager: { getSessionId: () => "session-1" },
    model: { provider: "local", id: "qwen-test" },
  };
}
