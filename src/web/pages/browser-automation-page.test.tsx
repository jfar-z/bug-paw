import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_BROWSER_AUTOMATION_CONFIG, type BrowserAutomationSettingsDocument } from "../../shared/browser-automation-contracts";
import { BrowserAutomationPage } from "./browser-automation-page";

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

  it("展示六个设置区与保守默认值", async () => {
    render(<BrowserAutomationPage />);
    expect(await screen.findByRole("heading", { name: "浏览器执行" })).toBeInTheDocument();
    for (const title of ["服务状态", "公开浏览范围", "受信任 UI 验证", "本地静态页面", "资源池", "浏览产物"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByLabelText("允许文本输入")).not.toBeChecked();
    expect(screen.getByLabelText("允许表单提交")).not.toBeChecked();
    expect(screen.getByLabelText("允许文件上传")).not.toBeChecked();
    expect(screen.getByLabelText("允许读取剪贴板")).not.toBeChecked();
    expect(screen.getByLabelText("允许写入剪贴板")).not.toBeChecked();
    expect(screen.getByText("所有公网 HTTPS 站点")).toBeInTheDocument();
  });

  it("新增精确 Origin、修改开关并保存完整草稿", async () => {
    render(<BrowserAutomationPage />);
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

  it("离线时读取缓存并禁用测试与保存", async () => {
    window.localStorage.setItem("bugpaw:browser-automation:offline:v1", JSON.stringify({ ...settings(), savedAt: "2026-08-12T00:00:00.000Z" }));
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    render(<BrowserAutomationPage />);
    expect(await screen.findByText(/离线只读/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试浏览器组件" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "保存浏览器设置" })).toBeDisabled();
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
