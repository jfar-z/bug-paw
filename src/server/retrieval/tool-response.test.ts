// @vitest-environment node

import { describe, expect, it } from "vitest";

import { emptyResponse, errorResponse, okResponse, partialResponse, toPiToolResult } from "./tool-response";

describe("检索工具统一响应", () => {
  it("序列化成功、空结果和部分成功状态", () => {
    expect(okResponse({ value: 1 }, { resultCount: 1 })).toEqual({
      status: "ok",
      data: { value: 1 },
      metadata: { resultCount: 1 },
      warnings: [],
    });
    expect(emptyResponse({ results: [] }, { resultCount: 0 })).toMatchObject({ status: "empty" });
    expect(partialResponse(
      { results: [1] },
      { resultCount: 1 },
      [{ code: "DEGRADED", message: "发生降级" }],
    )).toMatchObject({
      status: "partial",
      warnings: [{ code: "DEGRADED", message: "发生降级" }],
    });
  });

  it("错误仅暴露代码、消息和是否可重试", () => {
    const response = errorResponse("WEB_FETCH_FAILED", "网页读取失败", true);
    expect(response).toEqual({
      status: "error",
      error: { code: "WEB_FETCH_FAILED", message: "网页读取失败", retryable: true },
    });
    expect(JSON.stringify(response)).not.toMatch(/nextAction|suggestion|recommendation/u);
  });

  it("转换为 Pi 文本内容时保留完整 JSON", () => {
    const response = okResponse({ value: "证据" }, { resultCount: 1 });
    const result = toPiToolResult(response);
    expect(JSON.parse(result.content[0].text)).toEqual(response);
    expect(result.details).toEqual({});
  });
});
