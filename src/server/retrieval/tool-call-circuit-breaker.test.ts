// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  classifyToolCallArguments,
  createToolCallCircuitBreaker,
  type ToolCallCircuitBreakerDiagnostic,
} from "./tool-call-circuit-breaker";

describe("工具空参数断路器", () => {
  it("前两次空对象放行，第三次要求终止当前 Run", () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const breaker = createToolCallCircuitBreaker([
      requiredActionTool("knowledge_manage"),
    ], (event) => diagnostics.push(event));
    breaker.reset();

    expect(breaker.observe(call("knowledge_manage", {}))).toEqual({ terminate: false });
    expect(breaker.observe(call("knowledge_manage", {}))).toEqual({ terminate: false });
    expect(breaker.observe(call("knowledge_manage", {}))).toEqual({ terminate: true });

    expect(diagnostics.map(({ count, action }) => ({ count, action }))).toEqual([
      { count: 1, action: "allowed" },
      { count: 2, action: "allowed" },
      { count: 3, action: "terminated" },
    ]);
  });

  it("新的 Run 会清除之前的连续计数", () => {
    const breaker = createToolCallCircuitBreaker([requiredActionTool("knowledge_manage")]);
    breaker.observe(call("knowledge_manage", {}));
    breaker.observe(call("knowledge_manage", {}));

    breaker.reset();

    expect(breaker.observe(call("knowledge_manage", {}))).toEqual({ terminate: false });
  });

  it("有效参数或其他工具会打断连续空调用", () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const breaker = createToolCallCircuitBreaker([
      requiredActionTool("knowledge_manage"),
      requiredActionTool("knowledge_read"),
    ], (event) => diagnostics.push(event));

    breaker.observe(call("knowledge_manage", {}));
    breaker.observe(call("knowledge_manage", {}));
    breaker.observe(call("knowledge_manage", { action: "list_bases" }));
    breaker.observe(call("knowledge_manage", {}));
    breaker.observe(call("knowledge_read", {}));
    breaker.observe(call("knowledge_manage", {}));

    expect(diagnostics.map(({ toolName, count }) => ({ toolName, count }))).toEqual([
      { toolName: "knowledge_manage", count: 1 },
      { toolName: "knowledge_manage", count: 2 },
      { toolName: "knowledge_manage", count: 1 },
      { toolName: "knowledge_read", count: 1 },
      { toolName: "knowledge_manage", count: 1 },
    ]);
  });

  it("没有必填字段的工具不进入断路计数", () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const breaker = createToolCallCircuitBreaker([
      { ...requiredActionTool("optional_tool"), parameters: { type: "object", properties: {} } },
    ], (event) => diagnostics.push(event));

    expect(breaker.observe(call("optional_tool", {}))).toEqual({ terminate: false });
    expect(diagnostics).toEqual([]);
  });

  it("稳定分类缺失、空对象、畸形与有效参数", () => {
    expect(classifyToolCallArguments(undefined)).toBe("missing");
    expect(classifyToolCallArguments(null)).toBe("missing");
    expect(classifyToolCallArguments({})).toBe("empty_object");
    expect(classifyToolCallArguments([])).toBe("malformed");
    expect(classifyToolCallArguments("bad")).toBe("malformed");
    expect(classifyToolCallArguments({ action: "list_bases" })).toBe("valid");
  });

  it("诊断只包含枚举状态，不包含原始参数正文", () => {
    const diagnostics: ToolCallCircuitBreakerDiagnostic[] = [];
    const breaker = createToolCallCircuitBreaker([
      requiredActionTool("knowledge_manage"),
    ], (event) => diagnostics.push(event));

    breaker.observe(call("knowledge_manage", "private-value"));

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

  it("会话列表、搜索与阅读工具的必填字段会进入空参数断路", () => {
    const breaker = createToolCallCircuitBreaker([
      requiredActionTool("session_list"),
      requiredActionTool("session_search"),
      requiredActionTool("session_read"),
    ]);

    expect(breaker.observe(call("session_list", {}))).toEqual({ terminate: false });
    expect(breaker.observe(call("session_list", {}))).toEqual({ terminate: false });
    expect(breaker.observe(call("session_list", {}))).toEqual({ terminate: true });
    expect(breaker.observe(call("session_search", undefined))).toEqual({ terminate: false });
    expect(breaker.observe(call("session_search", undefined))).toEqual({ terminate: false });
    expect(breaker.observe(call("session_search", undefined))).toEqual({ terminate: true });
    expect(breaker.observe(call("session_read", {}))).toEqual({ terminate: false });
  });
});

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

/** 创建运行时工具开始事件所需的最小输入。 */
function call(toolName: string, args: unknown) {
  return {
    sessionId: "session-1",
    provider: "local",
    model: "qwen-test",
    toolName,
    args,
  };
}
