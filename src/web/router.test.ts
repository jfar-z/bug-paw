import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { navigateTo, parseRoute, routePath, useBrowserRoute } from "./router";

beforeEach(() => {
  window.history.replaceState({}, "", "/chat");
});

describe("工作台路由", () => {
  it("解析一级工作台模块，且不劫持配置资源页", () => {
    expect(parseRoute("/resources")).toEqual({ page: "workspace-resources" });
    expect(parseRoute("/knowledge-base")).toEqual({ page: "knowledge-base" });
    expect(parseRoute("/scheduled-tasks")).toEqual({ page: "scheduled-tasks" });
    expect(parseRoute("/settings/resources")).toEqual({ page: "resources" });
  });

  it("为新增一级工作台模块生成稳定路径", () => {
    expect(routePath({ page: "workspace-resources" })).toBe("/resources");
    expect(routePath({ page: "knowledge-base" })).toBe("/knowledge-base");
    expect(routePath({ page: "scheduled-tasks" })).toBe("/scheduled-tasks");
  });

  it("解析 AIGC 工作台与详情深链", () => {
    expect(parseRoute("/aigc")).toEqual({ page: "aigc-overview" });
    expect(parseRoute("/aigc/run")).toEqual({ page: "aigc-run" });
    expect(parseRoute("/aigc/run", "?interface=comfy-main")).toEqual({ page: "aigc-run", interfaceId: "comfy-main" });
    expect(parseRoute("/aigc/interfaces")).toEqual({ page: "aigc-interfaces" });
    expect(parseRoute("/aigc/tasks")).toEqual({ page: "aigc-tasks" });
    expect(parseRoute("/aigc/outputs")).toEqual({ page: "aigc-outputs" });
    expect(parseRoute("/aigc/public-directory")).toEqual({ page: "aigc-public-directory" });
    expect(parseRoute("/aigc/workflows")).toEqual({ page: "aigc-workflows" });
    expect(parseRoute("/aigc/interfaces/flux")).toEqual({ page: "aigc-interface-detail", interfaceId: "flux" });
    expect(parseRoute("/aigc/tasks/task-1")).toEqual({ page: "aigc-task-detail", taskId: "task-1" });
    expect(parseRoute("/aigc/workflows/wf-1")).toEqual({ page: "aigc-workflow-detail", workflowId: "wf-1" });
    expect(routePath({ page: "aigc-overview" })).toBe("/aigc");
    expect(routePath({ page: "aigc-run" })).toBe("/aigc/run");
    expect(routePath({ page: "aigc-run", interfaceId: "comfy main" })).toBe("/aigc/run?interface=comfy%20main");
    expect(routePath({ page: "aigc-interface-detail", interfaceId: "flux" })).toBe("/aigc/interfaces/flux");
    expect(routePath({ page: "aigc-outputs" })).toBe("/aigc/outputs");
    expect(routePath({ page: "aigc-public-directory" })).toBe("/aigc/public-directory");
  });

  it("解析配置中心 AIGC 渠道页", () => {
    expect(parseRoute("/settings/capabilities/aigc-channels")).toEqual({ page: "aigc-channels" });
    expect(routePath({ page: "aigc-channels" })).toBe("/settings/capabilities/aigc-channels");
  });

  it("解析配置中心深链", () => {
    expect(parseRoute("/settings/agents/default")).toEqual({
      page: "agent-detail",
      agentId: "default",
    });
    expect(parseRoute("/settings/providers")).toEqual({ page: "providers" });
    expect(parseRoute("/settings/capabilities/web-research")).toEqual({ page: "web-research" });
    expect(parseRoute("/settings/capabilities/browser")).toEqual({ page: "browser-automation" });
    expect(routePath({ page: "capabilities" })).toBe("/settings/capabilities");
    expect(routePath({ page: "browser-automation" })).toBe("/settings/capabilities/browser");
  });

  it("未知路径回退到对话页", () => {
    expect(parseRoute("/not-found")).toEqual({ page: "chat" });
  });

  it("响应 History 导航和浏览器前进后退", () => {
    const { result } = renderHook(() => useBrowserRoute());

    act(() => navigateTo({ page: "agents" }));
    expect(result.current).toEqual({ page: "agents" });
    expect(window.location.pathname).toBe("/settings/agents");

    act(() => {
      window.history.replaceState({}, "", "/settings");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(result.current).toEqual({ page: "configuration-overview" });
  });

  it("允许编辑页在写入历史记录前阻止导航", () => {
    const prevent = (event: Event) => event.preventDefault();
    window.addEventListener("pi-agent:before-navigate", prevent);
    navigateTo({ page: "aigc-tasks" });
    expect(window.location.pathname).toBe("/chat");
    window.removeEventListener("pi-agent:before-navigate", prevent);
  });
});
