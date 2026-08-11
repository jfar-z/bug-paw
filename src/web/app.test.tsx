import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./app";
import { ErrorToastProvider } from "./error-toast-provider";

function renderApp() {
  return render(<ErrorToastProvider><App /></ErrorToastProvider>);
}

describe("App 首次初始化", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/chat");
  });

  it("初始化后自动登录并进入 Agent 创建提示", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/status") return new Response(JSON.stringify({ initialized: false, authenticated: false }));
      if (url === "/api/v1/setup") return new Response(JSON.stringify({ initialized: true }), { status: 201 });
      if (url === "/api/v1/login") return new Response(null, { status: 204 });
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderApp();
    await screen.findByRole("heading", { name: "创建访问密码" });
    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.change(screen.getByLabelText("使用的模型"), { target: { value: "test-model" } });
    fireEvent.submit(screen.getByRole("button", { name: "完成初始化" }).closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/setup", expect.objectContaining({ method: "POST" })));
    const setupCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/v1/setup");
    const loginCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/v1/login");
    expect(JSON.parse(String(setupCall?.[1]?.body))).not.toHaveProperty("username");
    expect(JSON.parse(String(loginCall?.[1]?.body))).toEqual({
      password: "correct horse battery staple",
      remember: true,
    });
    await waitFor(() => expect(window.location.pathname).toBe("/settings/agents"));
    expect(window.location.search).toBe("?onboarding=create");
    expect(await screen.findByText("请先创建 Agent 后再开始对话。")).toBeInTheDocument();
  });

  it("加载工作台前展示 BugPaw 品牌化加载状态", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ initialized: true, authenticated: true }))));

    renderApp();

    const loading = screen.getByRole("status", { name: "正在准备 BugPaw" });
    expect(within(loading).getByAltText("睡眠中的 BUG 猫咪像素吉祥物"))
      .toHaveAttribute("src", "/brand/bugpaw/bugpaw-sleeping.png");
  });

  it("认证后将资源管理深链渲染为 Agent 工作目录页面", async () => {
    window.history.replaceState({}, "", "/resources");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") {
        return new Response(JSON.stringify({ initialized: true, authenticated: true }));
      }
      if (String(input) === "/api/v1/agents") {
        return new Response(JSON.stringify({ agents: [] }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderApp();

    expect(await screen.findByRole("heading", { name: "资源管理" })).toBeInTheDocument();
    expect(screen.getByText("请先在配置中心创建 Agent。")).toBeInTheDocument();
  });

  it("移动端工作台在首次点按前显示入场层", async () => {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query.includes("max-width") || query.includes("pointer"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/status") {
        return new Response(JSON.stringify({ initialized: true, authenticated: true }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderApp();

    const enterButton = await screen.findByRole("button", { name: "进入工作台" });
    const entryGate = screen.getByRole("dialog", { name: "从这里继续工作" });
    expect(within(entryGate).getByAltText("BUG 猫咪像素吉祥物")).toHaveAttribute("src", "/brand/bugpaw/bugpaw-mascot.png");
    expect(within(entryGate).getByText("BUGPAW / WORKBENCH")).toBeInTheDocument();
    fireEvent.click(enterButton);
    expect(screen.queryByRole("button", { name: "进入工作台" })).not.toBeInTheDocument();
  });

  it("启动请求发生意外错误时同时展示状态页和全局 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: {
        code: "INTERNAL_ERROR",
        message: "服务启动失败",
        requestId: "request-app-startup",
      },
    }), { status: 500 })));

    renderApp();

    expect(await screen.findByText("无法连接 Agent 服务，请检查容器状态。")).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
  });
});
