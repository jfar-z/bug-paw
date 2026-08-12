import { describe, expect, it } from "vitest";

import { assertSafeTextInput, isSubmitLike, type BrowserElementDescriptor } from "./action-safety";

/** Worker 必须在执行前拦截敏感字段和隐式提交。 */
describe("浏览器动作安全判定", () => {
  it.each([
    { type: "password", accessibleName: "密码" },
    { autocomplete: "current-password", accessibleName: "登录信息" },
    { autocomplete: "new-password", accessibleName: "新凭证" },
    { autocomplete: "one-time-code", accessibleName: "验证码" },
    { autocomplete: "cc-number", accessibleName: "卡号" },
    { type: "text", accessibleName: "API Key" },
    { type: "text", accessibleName: "恢复码" },
  ])("拒绝敏感输入字段 %#", (descriptor) => {
    expect(() => assertSafeTextInput(element(descriptor))).toThrow(expect.objectContaining({
      code: "BROWSER_HARD_SAFETY_BLOCKED",
    }));
  });

  it("允许普通搜索输入", () => {
    expect(() => assertSafeTextInput(element({ type: "search", accessibleName: "搜索文档" }))).not.toThrow();
  });

  it.each([
    { tagName: "button", type: "submit", accessibleName: "保存" },
    { tagName: "input", type: "submit", accessibleName: "发送" },
    { tagName: "button", type: "button", accessibleName: "立即支付" },
    { tagName: "a", role: "button", accessibleName: "删除账号" },
  ])("识别提交或不可逆动作 %#", (descriptor) => {
    expect(isSubmitLike(element(descriptor))).toBe(true);
  });

  it("普通链接不被误判为提交", () => {
    expect(isSubmitLike(element({ tagName: "a", accessibleName: "查看下一页" }))).toBe(false);
  });
});

/** 创建具有安全默认值的元素描述。 */
function element(overrides: Partial<BrowserElementDescriptor>): BrowserElementDescriptor {
  return { tagName: "input", type: "text", autocomplete: "", role: "textbox", accessibleName: "普通字段", ...overrides };
}
