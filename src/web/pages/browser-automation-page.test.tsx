import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_AUTOMATION_CONFIG, type BrowserAutomationSettingsDocument } from "../../shared/browser-automation-contracts";
import { ErrorToastProvider } from "../error-toast-provider";
import { BrowserAutomationPage } from "./browser-automation-page";

/** 使用应用实际错误 Toast 根节点渲染浏览器配置页。 */
function renderPage() {
  return render(<ErrorToastProvider><BrowserAutomationPage /></ErrorToastProvider>);
}

/** 浏览器能力页覆盖状态、权限、Origin、离线只读和保存。 */
describe("浏览器执行配置页", () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return json(settings({ config: JSON.parse(String(init.body)).config, revision: "r2" }));
      if (String(input).endsWith("/test")) return json({ ok: true, message: "浏览器组件可用" });
      return json(settings());
    }));
  });

it("新增精确 Origin、修改开关并保存完整草稿", async () => {
    renderPage();
    await screen.findByText("所有公网 HTTPS 站点");
    fireEvent.change(screen.getByLabelText("新增受信任 Origin"), { target: { value: "https://ui.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 Origin" }));
    fireEvent.click(screen.getByLabelText("启用浏览器执行"));
    fireEvent.click(screen.getAllByLabelText("允许文本输入")[0]!);
    fireEvent.click(screen.getAllByLabelText("允许读取剪贴板")[0]!);
    fireEvent.click(screen.getByRole("button", { name: "保存浏览器设置" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/capabilities/browser", expect.objectContaining({ method: "PATCH" })));
    const request = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ config: { enabled: true, trustedOrigins: [{ origin: "https://ui.example.com", allowTextInput: true, grantedPermissions: ["clipboard-read"] }] } });
  });

});

function settings(overrides: Partial<BrowserAutomationSettingsDocument> = {}): BrowserAutomationSettingsDocument {
  return {
    revision: "r1",
    config: structuredClone(DEFAULT_BROWSER_AUTOMATION_CONFIG),
    deployment: { available: true, workerAvailable: true, chromiumReady: true, activeContexts: 0, queuedRequests: 0 },
    ...overrides,
  };
}

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } }); }
