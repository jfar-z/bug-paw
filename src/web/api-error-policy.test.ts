import { describe, expect, it } from "vitest";

import { ApiClientError } from "./api";
import { toUnexpectedErrorNotice } from "./api-error-policy";

/** 错误提示必须保留可定位的故障事实。 */
describe("toUnexpectedErrorNotice", () => {
  it("展示 API 消息、错误码、状态和请求标识", () => {
    const notice = toUnexpectedErrorNotice(
      new ApiClientError("MODEL_RUNTIME_UNAVAILABLE", "模型 Runtime 尚未完成初始化", 503, "req-123"),
      "加载模型目录",
    );
    expect(notice).toMatchObject({
      title: "加载模型目录失败",
      summary: "模型 Runtime 尚未完成初始化",
      code: "MODEL_RUNTIME_UNAVAILABLE",
      status: 503,
      requestId: "req-123",
    });
  });

  it("展示前端运行时异常消息并隐藏凭据", () => {
    const notice = toUnexpectedErrorNotice(new Error("socket closed authorization=secret-value"), "同步会话");
    expect(notice.summary).toBe("socket closed authorization: [已隐藏]");
    expect(notice.code).toBe("CLIENT_RUNTIME_ERROR");
  });
});
