import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { errorResponse } from "../retrieval/tool-response";
import { SearchRunState } from "./search-run-state";

/** 运行时注册的隐藏搜索断路扩展。 */
export interface SearchRunCircuitExtension {
  name: string;
  hidden: true;
  factory: ExtensionFactory;
}

/** 从公开工具协议读取最终不可用事实，兼容不直接共享 Router 状态的运行器。 */
function readProviderUnavailableRetryable(content: readonly unknown[]): boolean | undefined {
  const textContent = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  if (!isRecord(textContent) || typeof textContent.text !== "string") return undefined;
  try {
    const response: unknown = JSON.parse(textContent.text);
    return isRecord(response)
      && response.status === "error"
      && isRecord(response.error)
      && response.error.code === "SEARCH_PROVIDERS_UNAVAILABLE"
      && typeof response.error.retryable === "boolean"
      ? response.error.retryable
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 创建 Run 级搜索断路器。
 *
 * 供应商不可用后仅阻止当前 Run 的重复搜索，不终止 Agent，也不影响网页读取等其他工具。
 */
export function createSearchRunCircuitExtension(state = new SearchRunState()): SearchRunCircuitExtension {
  return {
    name: "bug-paw-search-run-circuit",
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", () => {
        state.reset();
      });
      pi.on("tool_result", (event) => {
        if (event.toolName !== "web_search" || state.circuit().open) return;
        const retryable = readProviderUnavailableRetryable(event.content);
        if (retryable === undefined) return;
        state.recordUnavailable({ provider: "route", category: "upstream_error", retryable });
        state.openCircuit();
      });
      pi.on("tool_call", (event) => {
        const circuit = state.circuit();
        if (event.toolName !== "web_search" || !circuit.open) return undefined;
        return {
          block: true,
          reason: JSON.stringify(
            errorResponse(
              "SEARCH_PROVIDERS_UNAVAILABLE",
              "搜索供应商当前不可用，本次运行不再重复请求",
              circuit.retryable,
            ),
            null,
            2,
          ),
        };
      });
    },
  };
}
