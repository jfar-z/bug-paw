import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { DiagnosticsPage } from "./diagnostics-page";

function renderDiagnosticsPage(reloadPage?: () => void) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><DiagnosticsPage reloadPage={reloadPage} /></ApiTaskProvider></ErrorToastProvider>);
}

describe("DiagnosticsPage", () => {
  it("展示版本、挂载和诊断，并可手动刷新", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      generatedAt: "2026-08-05T00:00:00.000Z",
      version: { app: "0.1.0", node: "v24", pi: "0.83.0" },
      mounts: [{ source: "/host/data", target: "/data", writable: true }],
      diagnostics: [{ source: "auth", severity: "warning", code: "PROVIDER_CREDENTIAL_MISSING", message: "Provider cloud 尚未配置凭证" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderDiagnosticsPage();
    expect(await screen.findByText("Provider cloud 尚未配置凭证")).toBeInTheDocument();
    expect(screen.getByText("0.83.0")).toBeInTheDocument();
    expect(screen.getByText("/host/data → /data")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "刷新诊断" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("确认后中断活动会话、刷新核心配置并自动刷新前端页面", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/configuration/refresh-runtime") {
        return new Response(JSON.stringify({ abortedSessions: 2 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        generatedAt: "2026-08-05T00:00:00.000Z",
        version: { app: "0.1.0", node: "v24", pi: "0.83.0" },
        mounts: [],
        diagnostics: [],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const reloadPage = vi.fn();
    renderDiagnosticsPage(reloadPage);
    await screen.findByText("未发现配置问题");

    fireEvent.click(screen.getByRole("button", { name: "刷新核心配置" }));
    expect(screen.getByRole("dialog", { name: "确认刷新核心配置" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "继续刷新" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/configuration/refresh-runtime", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("已中断 2 个活动会话并刷新核心配置，正在刷新页面…")).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/v1/configuration/diagnostics")).toHaveLength(2);
    await waitFor(() => expect(reloadPage).toHaveBeenCalledOnce());
  });

  it("诊断请求发生意外错误时显示全局 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("diagnostics network secret"); }));
    renderDiagnosticsPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("diagnostics network secret")).not.toBeInTheDocument();
  });
});
