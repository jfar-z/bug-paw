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
    window.localStorage.clear();
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

});
