import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

import { errorResponse } from "../retrieval/tool-response";

/** 运行时注册的隐藏搜索断路扩展。 */
export interface SearchRunCircuitExtension {
  name: string;
  hidden: true;
  factory: ExtensionFactory;
}

/** 读取统一搜索供应商不可用错误的可重试事实。 */
function readProviderUnavailableRetryable(content: readonly unknown[]): boolean | undefined {
  const textContent = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  if (!isRecord(textContent) || typeof textContent.text !== "string") return undefined;
  try {
    const response: unknown = JSON.parse(textContent.text);
    if (isRecord(response)
      && response.status === "error"
      && isRecord(response.error)
      && response.error.code === "SEARCH_PROVIDERS_UNAVAILABLE"
      && typeof response.error.retryable === "boolean") {
      return response.error.retryable;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 判断未知值是否为可安全读取的对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 创建 Run 级搜索断路器。
 *
 * 供应商不可用后仅阻止当前 Run 的重复搜索，不终止 Agent，也不影响网页读取等其他工具。
 */
export function createSearchRunCircuitExtension(): SearchRunCircuitExtension {
  return {
    name: "bug-paw-search-run-circuit",
    hidden: true,
    factory: (pi) => {
      let providerUnavailableRetryable: boolean | undefined;

      pi.on("before_agent_start", () => {
        providerUnavailableRetryable = undefined;
      });
      pi.on("tool_result", (event) => {
        if (event.toolName === "web_search") {
          const retryable = readProviderUnavailableRetryable(event.content);
          if (retryable !== undefined) providerUnavailableRetryable = retryable;
        }
      });
      pi.on("tool_call", (event) => {
        if (event.toolName !== "web_search" || providerUnavailableRetryable === undefined) return undefined;
        return {
          block: true,
          reason: JSON.stringify(
            errorResponse(
              "SEARCH_PROVIDERS_UNAVAILABLE",
              "搜索供应商当前不可用，本次运行不再重复请求",
              providerUnavailableRetryable,
            ),
            null,
            2,
          ),
        };
      });
    },
  };
}
