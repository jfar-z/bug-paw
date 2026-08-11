import { describe, expect, it } from "vitest";

import { createSearchRunCircuitExtension } from "./search-run-circuit-extension";
import { SearchRunState } from "./search-run-state";

type Handler = (event: never) => unknown;

/** 注册扩展并提取测试需要的事件处理器。 */
function registerHandlers() {
  const handlers = new Map<string, Handler>();
  const state = new SearchRunState();
  const extension = createSearchRunCircuitExtension(state);
  extension.factory({
    on: (event: string, handler: Handler) => {
      handlers.set(event, handler);
    },
  } as never);
  return { handlers, state };
}

describe("搜索 Run 级断路扩展", () => {
  it("供应商不可用后仅阻止本 Run 后续 web_search", () => {
    const { handlers, state } = registerHandlers();
    const toolCall = handlers.get("tool_call")!;

    expect(toolCall({ toolName: "web_search" } as never)).toBeUndefined();
    state.recordUnavailable({ provider: "primary", category: "timeout", retryable: true });
    state.openCircuit();

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
    const { handlers, state } = registerHandlers();
    const toolCall = handlers.get("tool_call")!;
    state.recordUnavailable({ provider: "primary", category: "timeout", retryable: true });
    state.openCircuit();
    expect(toolCall({ toolName: "web_search" } as never)).toMatchObject({ block: true });

    handlers.get("before_agent_start")!({} as never);

    expect(toolCall({ toolName: "web_search" } as never)).toBeUndefined();
  });

  it("未打开断路时不影响搜索", () => {
    const { handlers } = registerHandlers();
    expect(handlers.get("tool_call")!({ toolName: "web_search" } as never)).toBeUndefined();
  });
});
