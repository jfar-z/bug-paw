import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { navigateTo, parseRoute, routePath } from "../router";
import { SecurityPage } from "./security-page";
import { LoginPage } from "./login-page";

const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const codes = ["1234-ABCD-5678-EFAB-1234-ABCD-5678-EFAB"];
function show(node: ReactNode) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}>{node}</ApiTaskProvider></ErrorToastProvider>);
}
beforeEach(() => {
  window.history.replaceState({}, "", "/settings/security"); window.localStorage.clear();
  vi.spyOn(api, "getSecurityStatus").mockResolvedValue({ enabled: false, enabledAt: null, recoveryCodesRemaining: 0 });
  vi.spyOn(api, "beginTotpSetup").mockResolvedValue({ secret, qrCode: "data:image/png;base64,test", expiresAt: new Date(Date.now() + 300_000).toISOString() });
  vi.spyOn(api, "cancelTotpSetup").mockResolvedValue(undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function begin() {
  fireEvent.click(await screen.findByRole("button", { name: "开启双因素认证" }));
  fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "test-password" } });
  fireEvent.submit(document.getElementById("security-proof-form")!);
  await screen.findByRole("heading", { name: "绑定验证器" });
}

describe("安全设置与登录第二步", () => {
  it("深链路由往返稳定", () => {
    expect(parseRoute("/settings/security")).toEqual({ page: "security" });
    expect(routePath({ page: "security" })).toBe("/settings/security");
  });
  it("首次验证后才启用，错误保留绑定并提示，恢复码必须确认保存", async () => {
    const confirm = vi.spyOn(api, "confirmTotpSetup").mockRejectedValueOnce(new ApiClientError("TOTP_INVALID_CODE", "首次验证码无效", 400, "req-totp"))
      .mockResolvedValueOnce({ recoveryCodes: codes });
    show(<SecurityPage />); await begin();
    expect(screen.getByText("待验证 · 尚未启用")).toBeInTheDocument();
    expect(screen.getByLabelText("无法扫码？手动输入密钥")).toHaveValue(secret.match(/.{4}/g)!.join(" "));
    fireEvent.change(screen.getByLabelText(/6 位验证码/), { target: { value: "000001" } });
    fireEvent.submit(screen.getByRole("button", { name: "验证并启用" }).closest("form")!);
    await screen.findAllByText("首次验证码无效");
    expect(screen.getByText("待验证 · 尚未启用")).toBeInTheDocument();
    expect(screen.getByLabelText(/6 位验证码/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/6 位验证码/), { target: { value: "081804" } });
    fireEvent.submit(screen.getByRole("button", { name: "验证并启用" }).closest("form")!);
    await screen.findByRole("heading", { name: "保存恢复码" });
    expect(confirm).toHaveBeenLastCalledWith("081804");
    expect(screen.getByRole("button", { name: "完成设置" })).toBeDisabled();
    expect(window.localStorage.length).toBe(0);
    act(() => navigateTo({ page: "diagnostics" }));
    expect(window.location.pathname).toBe("/settings/security");
    const dialog = screen.getByRole("dialog", { name: "恢复码尚未保存" });
    expect(within(dialog).getByText(/双因素认证已经启用/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "继续设置" }));
    fireEvent.click(screen.getByLabelText("我已将恢复码保存到安全的位置"));
    fireEvent.click(screen.getByRole("button", { name: "完成设置" }));
    expect(screen.queryByText(codes[0])).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭双因素认证" })).toBeEnabled();
  });
  it("提交响应丢失不谎报未启用，刷新后按服务端状态显示", async () => {
    vi.spyOn(api, "confirmTotpSetup").mockRejectedValue(new ApiClientError("API_NETWORK_ERROR", "浏览器未收到确认响应", 0));
    show(<SecurityPage />); await begin();
    fireEvent.change(screen.getByLabelText(/6 位验证码/), { target: { value: "123456" } });
    fireEvent.submit(screen.getByRole("button", { name: "验证并启用" }).closest("form")!);
    await screen.findByText(/认证操作结果尚未确认/);
    expect(screen.queryByRole("button", { name: "验证并启用" })).not.toBeInTheDocument();
    vi.mocked(api.getSecurityStatus).mockResolvedValue({ enabled: true, enabledAt: "2026-01-01", recoveryCodesRemaining: 8 });
    fireEvent.click(screen.getByRole("button", { name: "刷新认证状态" }));
    expect(await screen.findByRole("button", { name: "重新生成恢复码" })).toBeEnabled();
  });
  it("取消绑定清除密钥，剪贴板不可用时提供手动复制", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    show(<SecurityPage />); await begin();
    fireEvent.click(screen.getByRole("button", { name: "复制密钥" }));
    await screen.findByText(/浏览器未允许自动复制/);
    expect(screen.getByLabelText("无法扫码？手动输入密钥")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "取消绑定" }));
    await screen.findByRole("button", { name: "开启双因素认证" });
    expect(api.cancelTotpSetup).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("无法扫码？手动输入密钥")).not.toBeInTheDocument();
  });
  it("离线不能绑定，已启用关闭需要密码与第二因素", async () => {
    vi.mocked(api.getSecurityStatus).mockResolvedValue({ enabled: true, enabledAt: "2026-01-01", recoveryCodesRemaining: 8 });
    const manage = vi.spyOn(api, "manageTotp").mockResolvedValue({ recoveryCodes: [] });
    show(<SecurityPage />);
    fireEvent.click(await screen.findByRole("button", { name: "关闭双因素认证" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("访问密码"), { target: { value: "test-password" } });
    fireEvent.change(within(dialog).getByLabelText(/6 位验证码/), { target: { value: "123456" } });
    fireEvent.submit(document.getElementById("security-proof-form")!);
    await screen.findByRole("button", { name: "开启双因素认证" });
    expect(manage).toHaveBeenCalledWith("disable", { password: "test-password", code: "123456", recovery: false });
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    expect(screen.getByRole("button", { name: "开启双因素认证" })).toBeDisabled();
  });
  it("密码通过后停留验证码阶段，支持恢复码与挑战过期返回密码", async () => {
    const onLogin = vi.fn().mockResolvedValue({ authenticated: false, requiresTwoFactor: true, expiresAt: new Date(Date.now() + 300_000).toISOString() });
    const onVerify = vi.fn().mockRejectedValueOnce(new ApiClientError("TOTP_INVALID_CODE", "验证码已经使用", 400))
      .mockRejectedValueOnce(new ApiClientError("TOTP_CHALLENGE_EXPIRED", "登录验证已过期", 410));
    show(<LoginPage onLogin={onLogin} onVerify={onVerify} />);
    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "test-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "进入 BugPaw" }).closest("form")!);
    await screen.findByRole("heading", { name: "验证你的身份" });
    expect(screen.queryByLabelText("访问密码")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("6 位验证码"), { target: { value: "081804" } });
    fireEvent.submit(screen.getByRole("button", { name: "验证并登录" }).closest("form")!);
    await screen.findByText("验证码已经使用");
    expect(onVerify).toHaveBeenCalledWith("081804", false);
    fireEvent.click(screen.getByRole("button", { name: "无法使用验证器？使用恢复码" }));
    fireEvent.change(screen.getByLabelText("一次性恢复码"), { target: { value: codes[0] } });
    fireEvent.submit(screen.getByRole("button", { name: "验证并登录" }).closest("form")!);
    await waitFor(() => expect(screen.getByLabelText("访问密码")).toBeInTheDocument());
    expect(onVerify).toHaveBeenLastCalledWith(codes[0], true);
    expect(screen.getByText("登录验证已过期")).toBeInTheDocument();
  });
});
