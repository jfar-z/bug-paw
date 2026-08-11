import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { LoginPage } from "./login-page";

function renderLogin(onLogin: (password: string, remember: boolean) => Promise<void> = vi.fn(async () => undefined)) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><LoginPage onLogin={onLogin} /></ApiTaskProvider></ErrorToastProvider>);
}

describe("LoginPage", () => {
  it("复刻 v0 双栏品牌结构并只显示访问密码", () => {
    renderLogin();

    expect(screen.getByRole("heading", { name: /让聪明的爪印/u })).toBeInTheDocument();
    expect(screen.getByText("本地优先")).toBeInTheDocument();
    expect(screen.getByText("工具原生")).toBeInTheDocument();
    expect(screen.getByText("知识增强")).toBeInTheDocument();
    expect(screen.getByAltText("BUG 猫咪与 BugPaw 品牌像素插画")).toHaveAttribute(
      "src",
      "/brand/bugpaw/bugpaw-og-hero.png",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("访问密码")).toHaveAttribute("type", "password");
    expect(screen.getByRole("checkbox", { name: "保持登录" })).toBeChecked();
    expect(screen.queryByRole("link", { name: "遇到问题？" })).not.toBeInTheDocument();
  });

  it("提交单密码和保持登录选择", async () => {
    const onLogin = vi.fn(async () => undefined);
    renderLogin(onLogin);

    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "test-password" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "保持登录" }));
    fireEvent.submit(screen.getByRole("button", { name: "进入 BugPaw" }).closest("form")!);

    expect(onLogin).toHaveBeenCalledWith("test-password", false);
  });

  it("支持显示密码、提交锁定和应用内错误", async () => {
    let rejectLogin: ((reason: Error) => void) | undefined;
    const onLogin = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectLogin = reject; }));
    renderLogin(onLogin);

    const password = screen.getByLabelText("访问密码");
    fireEvent.change(password, { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "显示密码" }));
    expect(password).toHaveAttribute("type", "text");
    fireEvent.submit(screen.getByRole("button", { name: "进入 BugPaw" }).closest("form")!);
    expect(await screen.findByRole("button", { name: "正在进入…" })).toBeDisabled();
    rejectLogin?.(new ApiClientError("INVALID_CREDENTIALS", "访问密码错误", 401));
    expect(await screen.findByText("访问密码错误")).toBeInTheDocument();
  });

  it("意外登录错误只进入全局 Toast", async () => {
    renderLogin(vi.fn(async () => { throw new Error("包含敏感上下文的内部错误"); }));
    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "wrong-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "进入 BugPaw" }).closest("form")!);

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("包含敏感上下文的内部错误")).not.toBeInTheDocument();
  });
});
