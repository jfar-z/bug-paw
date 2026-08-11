import { describe, expect, it } from "vitest";

import { createSearchRunCircuitExtension } from "./search-run-circuit-extension";

type Handler = (event: never) => unknown;

/** 注册扩展并提取测试需要的事件处理器。 */
function registerHandlers() {
  const handlers = new Map<string, Handler>();
  const extension = createSearchRunCircuitExtension();
  extension.factory({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as never);
  return handlers;
}

describe("搜索 Run 级断路扩展", () => {
  it("供应商不可用后仅阻止本 Run 后续 web_search", () => {
    const handlers = registerHandlers();
    const toolCall = handlers.get("tool_call")!;
    const toolResult = handlers.get("tool_result")!;

    expect(toolCall({ toolName: "web_search" } as never)).toBeUndefined();
    toolResult({
      toolName: "web_search",
      content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "SEARCH_PROVIDERS_UNAVAILABLE", retryable: true } }) }],
    } as never);

    const blocked = toolCall({ toolName: "web_search" } as never) as { block: boolean; reason: string; terminate?: boolean };
    expect(blocked.block).toBe(true);
    expect(blocked.terminate).toBeUndefined();
    expect(JSON.parse(blocked.reason)).toEqual({
      status: "error",
      error: { code: "SEARCH_PROVIDERS_UNAVAILABLE", message: "搜索供应商当前不可用，本次运行不再重复请求", retryable: true },
    });
    expect(toolCall({ toolName: "web_read" } as never)).toBeUndefined();
  });

  it("新 Run 开始时重置断路状态", () => {
    const handlers = registerHandlers();
    const toolCall = handlers.get("tool_call")!;
    handlers.get("tool_result")!({
      toolName: "web_search",
      content: [{ type: "text", text: JSON.stringify({ status: "error", error: { code: "SEARCH_PROVIDERS_UNAVAILABLE", retryable: true } }) }],
    } as never);
    expect(toolCall({ toolName: "web_search" } as never)).toMatchObject({ block: true });

    handlers.get("before_agent_start")!({} as never);

    expect(toolCall({ toolName: "web_search" } as never)).toBeUndefined();
  });

  it("忽略非标准错误和无法解析的工具正文", () => {
    const handlers = registerHandlers();
    const toolResult = handlers.get("tool_result")!;
    toolResult({ toolName: "web_search", content: [{ type: "text", text: "not-json" }] } as never);
    toolResult({ toolName: "web_search", content: [{ type: "text", text: JSON.stringify({ status: "empty" }) }] } as never);

    expect(handlers.get("tool_call")!({ toolName: "web_search" } as never)).toBeUndefined();
  });
});
