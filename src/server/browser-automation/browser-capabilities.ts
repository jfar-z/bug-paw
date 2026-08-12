import { BROWSER_TOOL_NAMES, type BrowserToolName } from "./browser-tools";

/** 当前 Runtime 实际可注册的浏览器能力。 */
export interface EffectiveBrowserCapabilities {
  /** 按稳定目录顺序排列的工具名。 */
  toolNames: BrowserToolName[];
}

/** 同时应用部署、全局开关与 Agent 工具白名单。 */
export function resolveBrowserCapabilities(input: {
  allowedTools: string[];
  enabled: boolean;
  deploymentAvailable: boolean;
}): EffectiveBrowserCapabilities {
  if (!input.enabled || !input.deploymentAvailable) return { toolNames: [] };
  const allowed = new Set(input.allowedTools);
  return { toolNames: BROWSER_TOOL_NAMES.filter((name) => allowed.has(name)) };
}
