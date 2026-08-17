import { useEffect, useState } from "react";

export type AppRoute =
  | { page: "chat" }
  | { page: "aigc-overview" }
  | { page: "aigc-interfaces" }
  | { page: "aigc-tasks" }
  | { page: "aigc-workflows" }
  | { page: "aigc-interface-detail"; interfaceId: string }
  | { page: "aigc-task-detail"; taskId: string }
  | { page: "aigc-workflow-detail"; workflowId: string }
  | { page: "workspace-resources" }
  | { page: "knowledge-base" }
  | { page: "scheduled-tasks" }
  | { page: "configuration-overview" }
  | { page: "capabilities" }
  | { page: "web-research" }
  | { page: "browser-automation" }
  | { page: "tts" }
  | { page: "knowledge-retrieval" }
  | { page: "aigc-channels" }
  | { page: "agents"; onboarding?: "create" }
  | { page: "providers" }
  | { page: "pi-settings" }
  | { page: "resources" }
  | { page: "configuration-operations" }
  | { page: "diagnostics" }
  | { page: "agent-detail"; agentId: string };

const NAVIGATION_EVENT = "pi-agent:navigate";
export const WORKBENCH_NAVIGATION_TOGGLE_EVENT = "pi-agent:toggle-workbench-navigation";
export const KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT = "pi-agent:toggle-knowledge-base-navigation";

/**
 * 将浏览器路径解析为工作台路由，未知地址安全回退到对话页。
 */
export function parseRoute(pathname: string, search = ""): AppRoute {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized === "/aigc") return { page: "aigc-overview" };
  if (normalized === "/aigc/interfaces") return { page: "aigc-interfaces" };
  if (normalized === "/aigc/tasks") return { page: "aigc-tasks" };
  if (normalized === "/aigc/workflows") return { page: "aigc-workflows" };
  const aigcInterfaceMatch = normalized.match(/^\/aigc\/interfaces\/([^/]+)$/);
  if (aigcInterfaceMatch) {
    try {
      return { page: "aigc-interface-detail", interfaceId: decodeURIComponent(aigcInterfaceMatch[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  const aigcTaskMatch = normalized.match(/^\/aigc\/tasks\/([^/]+)$/);
  if (aigcTaskMatch) {
    try {
      return { page: "aigc-task-detail", taskId: decodeURIComponent(aigcTaskMatch[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  const aigcWorkflowMatch = normalized.match(/^\/aigc\/workflows\/([^/]+)$/);
  if (aigcWorkflowMatch) {
    try {
      return { page: "aigc-workflow-detail", workflowId: decodeURIComponent(aigcWorkflowMatch[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  if (normalized === "/resources") return { page: "workspace-resources" };
  if (normalized === "/knowledge-base") return { page: "knowledge-base" };
  if (normalized === "/scheduled-tasks") return { page: "scheduled-tasks" };
  if (normalized === "/settings") {
    return { page: "configuration-overview" };
  }
  if (normalized === "/settings/capabilities") return { page: "capabilities" };
  if (normalized === "/settings/capabilities/web-research") return { page: "web-research" };
  if (normalized === "/settings/capabilities/browser") return { page: "browser-automation" };
  if (normalized === "/settings/capabilities/tts") return { page: "tts" };
  if (normalized === "/settings/capabilities/knowledge-retrieval") return { page: "knowledge-retrieval" };
  if (normalized === "/settings/capabilities/aigc-channels") return { page: "aigc-channels" };
  if (normalized === "/settings/agents") {
    return new URLSearchParams(search).get("onboarding") === "create"
      ? { page: "agents", onboarding: "create" }
      : { page: "agents" };
  }
  if (normalized === "/settings/providers") {
    return { page: "providers" };
  }
  if (normalized === "/settings/pi") {
    return { page: "pi-settings" };
  }
  if (normalized === "/settings/resources") {
    return { page: "resources" };
  }
  if (normalized === "/settings/operations") return { page: "configuration-operations" };
  if (normalized === "/settings/diagnostics") return { page: "diagnostics" };
  const match = normalized.match(/^\/settings\/agents\/([^/]+)$/);
  if (match) {
    try {
      return { page: "agent-detail", agentId: decodeURIComponent(match[1]) };
    } catch {
      return { page: "chat" };
    }
  }
  return { page: "chat" };
}

/**
 * 生成工作台路由对应的稳定路径。
 */
export function routePath(route: AppRoute): string {
  switch (route.page) {
    case "aigc-overview":
      return "/aigc";
    case "aigc-interfaces":
      return "/aigc/interfaces";
    case "aigc-tasks":
      return "/aigc/tasks";
    case "aigc-workflows":
      return "/aigc/workflows";
    case "aigc-interface-detail":
      return `/aigc/interfaces/${encodeURIComponent(route.interfaceId)}`;
    case "aigc-task-detail":
      return `/aigc/tasks/${encodeURIComponent(route.taskId)}`;
    case "aigc-workflow-detail":
      return `/aigc/workflows/${encodeURIComponent(route.workflowId)}`;
    case "workspace-resources":
      return "/resources";
    case "knowledge-base":
      return "/knowledge-base";
    case "scheduled-tasks":
      return "/scheduled-tasks";
    case "configuration-overview":
      return "/settings";
    case "capabilities":
      return "/settings/capabilities";
    case "web-research":
      return "/settings/capabilities/web-research";
    case "browser-automation":
      return "/settings/capabilities/browser";
    case "tts":
      return "/settings/capabilities/tts";
    case "knowledge-retrieval":
      return "/settings/capabilities/knowledge-retrieval";
    case "aigc-channels":
      return "/settings/capabilities/aigc-channels";
    case "agents":
      return route.onboarding === "create" ? "/settings/agents?onboarding=create" : "/settings/agents";
    case "providers":
      return "/settings/providers";
    case "pi-settings":
      return "/settings/pi";
    case "resources":
      return "/settings/resources";
    case "configuration-operations":
      return "/settings/operations";
    case "diagnostics":
      return "/settings/diagnostics";
    case "agent-detail":
      return `/settings/agents/${encodeURIComponent(route.agentId)}`;
    default:
      return "/chat";
  }
}

/**
 * 使用 History API 导航，并通知当前页面内的路由订阅者。
 */
export function navigateTo(route: AppRoute, replace = false): void {
  const method = replace ? "replaceState" : "pushState";
  window.history[method]({}, "", routePath(route));
  window.dispatchEvent(new Event(NAVIGATION_EVENT));
}

/**
 * 订阅 History API 和应用内导航事件。
 */
export function useBrowserRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname, window.location.search));

  useEffect(() => {
    const refresh = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", refresh);
    window.addEventListener(NAVIGATION_EVENT, refresh);
    return () => {
      window.removeEventListener("popstate", refresh);
      window.removeEventListener(NAVIGATION_EVENT, refresh);
    };
  }, []);

  return route;
}
