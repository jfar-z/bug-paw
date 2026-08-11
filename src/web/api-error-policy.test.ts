import { describe, expect, it } from "vitest";
import { ApiClientError } from "./api";
import * as apiErrorPolicy from "./api-error-policy";
import {
  isCancelledError,
  toUnexpectedErrorNotice,
} from "./api-error-policy";

describe("API 意外错误策略", () => {
  it("将 AbortError 识别为无需提示的请求取消", async () => {
    expect(isCancelledError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("保留统一 API 错误中的安全诊断字段", () => {
    expect(toUnexpectedErrorNotice(
      new ApiClientError("INTERNAL_ERROR", "服务暂时不可用", 500, "request-1"),
      "保存 Provider",
    )).toEqual({
      operation: "保存 Provider",
      title: "操作未完成",
      summary: "请稍后重试；如问题持续发生，请查看详情并提供请求标识。",
      code: "INTERNAL_ERROR",
      status: 500,
      requestId: "request-1",
      safeDetail: "服务暂时不可用",
    });
  });

  it("不向 Toast 复制普通异常中的底层内容", () => {
    const notice = toUnexpectedErrorNotice(
      new Error("Authorization data and private query must stay hidden"),
      "加载配置",
    );

    expect(JSON.stringify(notice)).not.toContain("Authorization data");
    expect(JSON.stringify(notice)).not.toContain("private query");
    expect(notice).toMatchObject({
      operation: "加载配置",
      title: "操作未完成",
    });
  });

  it("优先使用请求标识和错误码生成稳定去重键", () => {
    const makeKey = (apiErrorPolicy as Partial<typeof apiErrorPolicy> & {
      unexpectedErrorDedupeKey?: (input: {
        operation: string;
        title: string;
        summary: string;
        code?: string;
        requestId?: string;
      }) => string;
    }).unexpectedErrorDedupeKey;

    expect(makeKey?.({
      operation: "保存 Provider",
      title: "操作未完成",
      summary: "请求失败",
      code: "INTERNAL_ERROR",
      requestId: "request-1",
    })).toBe("request-1:INTERNAL_ERROR");
  });

  it("缺少请求标识时使用操作、错误码和摘要去重", () => {
    expect(apiErrorPolicy.unexpectedErrorDedupeKey({
      operation: "加载配置",
      title: "操作未完成",
      summary: "请求失败",
      code: "REQUEST_FAILED",
    })).toBe("加载配置:REQUEST_FAILED:请求失败");
  });

});
