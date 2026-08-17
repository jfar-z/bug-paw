import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AgentsPage } from "../pages/agents-page";
import type { AppRoute } from "../router";
import { WorkbenchShell } from "./workbench-shell";

function renderShell(route: AppRoute = { page: "agents" }) {
  const onNavigate = vi.fn();
  const onLogout = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    agents: [{
      profile: {
        id: "default", name: "默认 Agent", cwd: "/data/workspace", status: "active", description: "历史 Agent",
      },
      revision: "r1",
    }],
  }), { status: 200 })));
  const rendered = render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <WorkbenchShell
          route={route}
          theme="light"
          onThemeChange={vi.fn()}
          onNavigate={onNavigate}
          onLogout={onLogout}
        >
          <AgentsPage onNavigate={onNavigate} />
        </WorkbenchShell>
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
  return { ...rendered, onNavigate, onLogout };
}

describe("WorkbenchShell", () => {
  it("以实际可视高度变量约束工作台，避免刷新后输入区越过屏幕底部", () => {
    renderShell({ page: "chat" });

    expect(document.querySelector(".workbench-shell")).toHaveStyle({ height: "var(--app-viewport-height, 100dvh)" });
  });

  it("配置页同时显示主导航和配置二级导航", () => {
    renderShell();

    expect(screen.getByRole("navigation", { name: "工作台主导航" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "配置中心导航" })).toBeInTheDocument();
  });

  it("联网搜索页使用可滚动的配置内容容器", () => {
    renderShell({ page: "web-research" });

    expect(screen.getByRole("navigation", { name: "配置中心导航" })).toBeInTheDocument();
    expect(document.querySelector(".configuration-content")).toBeInTheDocument();
  });

  it("浏览器执行页保留配置导航并使用可滚动的配置内容容器", () => {
    renderShell({ page: "browser-automation" });

    expect(screen.getByRole("navigation", { name: "配置中心导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "浏览器执行" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector(".configuration-content")).toBeInTheDocument();
    expect(document.querySelector(".workbench-shell")).toHaveClass("is-configuration");
  });

  it.each<AppRoute>([
    { page: "tts" },
    { page: "knowledge-retrieval" },
  ])("语音与语义检索页保留配置二级导航：%o", (route) => {
    renderShell(route);

    expect(screen.getByRole("navigation", { name: "配置中心导航" })).toBeInTheDocument();
    expect(document.querySelector(".configuration-content")).toBeInTheDocument();
  });

  it("以固定顺序展示六个工作台一级菜单", () => {
    renderShell({ page: "chat" });

    const navigation = screen.getByRole("navigation", { name: "工作台主导航" });
    expect(within(navigation).getAllByRole("button").map((button) => button.getAttribute("aria-label")))
      .toEqual(["会话", "AIGC 工作台", "资源管理", "知识库", "定时任务", "配置中心"]);
  });

  it("Agent 列表进入全宽详情，不创建第三层常驻侧栏", async () => {
    const { onNavigate } = renderShell();

    fireEvent.click(await screen.findByRole("button", { name: /打开默认 Agent/ }));
    expect(onNavigate).toHaveBeenCalledWith({ page: "agent-detail", agentId: "default" });
    expect(document.querySelector(".agent-detail-sidebar")).not.toBeInTheDocument();
  });

  it("移动端分别通过三横和工作台按钮控制二级与一级导航", () => {
    renderShell();

    const configurationTrigger = screen.getByRole("button", { name: "打开配置导航" });
    expect(configurationTrigger).toBeEnabled();
    fireEvent.click(configurationTrigger);
    expect(configurationTrigger).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(".configuration-sidebar")).toHaveClass("is-open");

    const workspaceTrigger = screen.getByRole("button", { name: "打开工作台导航" });
    expect(workspaceTrigger).toHaveClass("chat-workbench-switcher");
    fireEvent.click(workspaceTrigger);
    expect(workspaceTrigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByRole("button", { name: "配置中心" }));
    expect(within(screen.getByRole("navigation", { name: "配置中心导航" })).getAllByText("Agents").at(-1)).toBeVisible();
  });

  it("AIGC 工作台展示独立二级导航与可滚动内容容器", () => {
    renderShell({ page: "aigc-overview" });

    expect(screen.getByRole("navigation", { name: "AIGC 工作台导航" })).toBeInTheDocument();
    expect(document.querySelector(".aigc-workbench-content")).toBeInTheDocument();
    expect(document.querySelector(".workbench-shell")).toHaveClass("is-aigc");
  });

  it("AIGC 详情路由保持二级导航选中态", () => {
    renderShell({ page: "aigc-workflow-detail", workflowId: "wf-1" });

    expect(screen.getByRole("button", { name: "工作流" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation", { name: "AIGC 工作台导航" })).toBeInTheDocument();
  });

  it("AIGC 创作台展示二级导航并标记当前入口", () => {
    renderShell({ page: "aigc-run" });

    expect(screen.getByRole("button", { name: "创作与运行" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation", { name: "AIGC 工作台导航" })).toBeInTheDocument();
  });

  it("AIGC 产物与公开目录路由保持独立选中态", () => {
    const first = renderShell({ page: "aigc-outputs" });
    expect(screen.getByRole("button", { name: "产物查看" })).toHaveAttribute("aria-current", "page");

    first.unmount();
    renderShell({ page: "aigc-public-directory" });
    expect(screen.getByRole("button", { name: "公开目录" })).toHaveAttribute("aria-current", "page");
  });

  it("配置中心展示 AIGC 渠道入口", () => {
    renderShell({ page: "aigc-channels" });

    expect(screen.getByRole("navigation", { name: "配置中心导航" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AIGC 渠道" })).toHaveAttribute("aria-current", "page");
  });

  it("资源管理页通过二级菜单按钮打开 Agent 列表", () => {
    renderShell({ page: "workspace-resources" });

    expect(screen.getByRole("button", { name: "打开 Agent 列表" })).not.toBeDisabled();
    expect(screen.getByRole("button", { name: "打开工作台导航" })).toBeVisible();
    expect(document.querySelector(".workbench-shell")).toHaveClass("is-workspace-resources");
  });

  it("定时任务页复用资源管理的 Agent 二级导航入口", () => {
    renderShell({ page: "scheduled-tasks" });

    expect(screen.getByRole("button", { name: "打开 Agent 列表" })).not.toBeDisabled();
    expect(document.querySelector(".workbench-shell")).toHaveClass("is-workspace-resources");
  });

  it("知识库页提供独立的知识库列表入口", () => {
    renderShell({ page: "knowledge-base" });

    expect(screen.getByRole("button", { name: "打开知识库列表" })).not.toBeDisabled();
    expect(document.querySelector(".workbench-shell")).toHaveClass("is-workspace-resources");
  });

  it("支持从主导航退出登录", () => {
    const { onLogout } = renderShell();

    fireEvent.click(screen.getByRole("button", { name: "退出登录" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("只在主导航左下角保留一个主题切换", () => {
    renderShell({ page: "chat" });

    expect(screen.getAllByRole("button", { name: /当前主题/ })).toHaveLength(1);
  });

  it("在主导航底部提供安全打开的 GitHub 仓库链接", () => {
    renderShell({ page: "chat" });

    const link = screen.getByRole("link", { name: "打开 BugPaw GitHub 仓库" });
    expect(link).toHaveAttribute("href", "https://github.com/jfar-z/bug-paw");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });
});
