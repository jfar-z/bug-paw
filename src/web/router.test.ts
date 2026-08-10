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

  it("解析配置中心深链", () => {
    expect(parseRoute("/settings/agents/default")).toEqual({
      page: "agent-detail",
      agentId: "default",
    });
    expect(parseRoute("/settings/providers")).toEqual({ page: "providers" });
    expect(parseRoute("/settings/capabilities/web-research")).toEqual({ page: "web-research" });
    expect(routePath({ page: "capabilities" })).toBe("/settings/capabilities");
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
});
