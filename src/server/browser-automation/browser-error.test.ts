import { describe, expect, it } from "vitest";

import { BrowserAutomationError, browserPolicyError } from "./browser-error";

/** 浏览器策略拒绝必须携带 Agent 可解释的配置指引。 */
describe("浏览器错误协议", () => {
  it("为可配置的文本输入拒绝返回精确设置路径", () => {
    const error = browserPolicyError("BROWSER_TEXT_INPUT_DISABLED", {
      operation: "text_input",
      origin: "https://staging.example.com",
      requiredSetting: "allowTextInput",
    });

    expect(error.toResult()).toEqual({
      status: "error",
      error: {
        code: "BROWSER_TEXT_INPUT_DISABLED",
        message: "当前 Origin 未启用文本输入能力",
        retryable: false,
        permission: {
          operation: "text_input",
          origin: "https://staging.example.com",
          scope: "trusted_ui_origin",
          requiredSetting: "allowTextInput",
          settingsPath: "/settings/capabilities/browser",
        },
        userGuidance: "请管理员在“配置中心 → 能力扩展 → 浏览器执行 → 受信任 UI 验证”中添加该 Origin，并开启“允许文本输入”。",
      },
    });
  });

  it("硬限制明确说明不能通过管理员配置解除", () => {
    const error = new BrowserAutomationError(
      "BROWSER_HARD_SAFETY_BLOCKED",
      "禁止输入密码或支付信息",
      false,
      undefined,
      "这是系统硬限制，不能通过配置中心解除。",
    );

    expect(error.toResult().error).toMatchObject({
      code: "BROWSER_HARD_SAFETY_BLOCKED",
      retryable: false,
      userGuidance: "这是系统硬限制，不能通过配置中心解除。",
    });
  });

  it("Worker 短暂故障标记为可重试但不泄露内部地址", () => {
    const error = new BrowserAutomationError("BROWSER_WORKER_UNAVAILABLE", "浏览器执行服务暂时不可用", true);

    expect(JSON.stringify(error.toResult())).not.toContain("browser-worker");
    expect(error.toResult().error.retryable).toBe(true);
  });
});
