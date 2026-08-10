import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SetupPage } from "./setup-page";

describe("SetupPage", () => {
  it("复用登录页的品牌与表单骨架呈现初始化品牌区", () => {
    render(<SetupPage theme="light" onThemeChange={vi.fn()} />);

    expect(document.querySelector(".setup-page.login-page")).toBeInTheDocument();
    expect(document.querySelector(".setup-page .login-brand-panel")).toBeInTheDocument();
    expect(document.querySelector(".setup-page .login-form-panel")).toBeInTheDocument();
    expect(document.querySelector(".setup-page .login-heading")).toBeInTheDocument();
    expect(document.querySelector(".setup-page .login-form")).toBeInTheDocument();
    expect(document.querySelector(".setup-page .login-security")).toBeInTheDocument();
    expect(document.querySelector(".setup-page .login-form-panel footer")).toBeInTheDocument();
    expect(screen.getByText("YOUR AI AGENT · BUILT FOR DEVELOPERS")).toBeInTheDocument();
    expect(screen.getByText("几步完成设置，开始和 BugPaw 一起工作。")).toBeInTheDocument();
    expect(screen.getByText("设置密码、连接模型，然后就可以开始和 BugPaw 一起工作。")).toBeInTheDocument();
    expect(screen.getByText("保护你的工作空间")).toBeInTheDocument();
    expect(screen.queryByText("当前")).not.toBeInTheDocument();
    expect(screen.queryByText("/data")).not.toBeInTheDocument();
    expect(screen.getByAltText("BUG 猫咪与 BugPaw 品牌像素插画")).toHaveAttribute(
      "src",
      "/brand/bugpaw/bugpaw-og-hero.png",
    );
  });

  it("只收集访问密码和确认密码", () => {
    render(<SetupPage theme="light" onThemeChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "创建访问密码" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /用户名/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("访问密码")).toBeInTheDocument();
    expect(screen.getByLabelText("确认密码")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续" })).toBeInTheDocument();
  });

  it("提交初始化时保持按钮禁用直到请求结束", async () => {
    let resolveSetup: (() => void) | undefined;
    const onComplete = vi.fn(() => new Promise<void>((resolve) => { resolveSetup = resolve; }));
    render(<SetupPage theme="light" onThemeChange={vi.fn()} onComplete={onComplete} />);

    fireEvent.change(screen.getByLabelText("访问密码"), { target: { value: "correct horse battery staple" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "继续" }));
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-key" } });
    fireEvent.change(screen.getByLabelText("使用的模型"), { target: { value: "test-model" } });
    fireEvent.submit(screen.getByRole("button", { name: "完成初始化" }).closest("form")!);

    expect(await screen.findByRole("button", { name: "正在初始化…" })).toBeDisabled();
    resolveSetup?.();
  });
});
