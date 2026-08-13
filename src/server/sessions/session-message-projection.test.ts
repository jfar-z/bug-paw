import { describe, expect, it } from "vitest";

import {
  MODEL_REQUEST_FAILED_MESSAGE,
  MODEL_RESPONSE_TRUNCATED_MESSAGE,
} from "../../shared/assistant-run-outcome";
import { projectSessionMessages, projectSessionToolResult } from "./session-message-projection";
import { compileQuestionResponseProtocol } from "../../shared/question-response-protocol";

describe("会话消息浏览器投影", () => {
  it("替换图片和超长工具文本但不修改原消息", () => {
    const original = [{
      role: "toolResult",
      content: [
        { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
        { type: "text", text: "x".repeat(32 * 1024 + 1) },
      ],
    }];
    const before = structuredClone(original);

    expect(projectSessionMessages(original)).toEqual([{
      role: "toolResult",
      content: [
        { type: "image", mimeType: "image/png", data: "<IMAGE_BASE64>", originalBytes: 8 },
        { type: "text", text: "<TOOL_RESULT_TOO_LONG>", truncated: true, originalBytes: 32 * 1024 + 1 },
      ],
    }]);
    expect(original).toEqual(before);
  });

  it("按 UTF-8 字节限制单块文本", () => {
    const projected = projectSessionMessages([{
      role: "toolResult",
      content: [{ type: "text", text: "中".repeat(11_000) }],
    }]);
    expect(projected[0]).toMatchObject({
      content: [{ text: "<TOOL_RESULT_TOO_LONG>", truncated: true, originalBytes: 33_000 }],
    });
  });

  it("累计预算耗尽后完整替换后续文本", () => {
    const messages = Array.from({ length: 9 }, () => ({
      role: "toolResult",
      content: [{ type: "text", text: "x".repeat(32 * 1024) }],
    }));
    expect(projectSessionMessages(messages)[8]).toMatchObject({
      content: [{ text: "<TOOL_RESULT_TOO_LONG>", truncated: true }],
    });
  });

  it("保留普通消息、纯文本内容和未知工具块", () => {
    const messages = [
      { role: "user", content: [{ type: "image", data: "user-image" }] },
      { role: "assistant", content: "answer" },
      { role: "toolResult", content: "plain result" },
      { role: "toolResult", content: [{ type: "custom", payload: { ok: true } }] },
    ];
    expect(projectSessionMessages(messages)).toEqual(messages);
  });

  it("异常结构使用安全占位且不会抛出", () => {
    const content = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(content, "type", { get: () => { throw new Error("broken"); } });
    expect(projectSessionMessages([{ role: "toolResult", content: [content] }])).toEqual([{
      role: "toolResult",
      content: [{ type: "text", text: "<TOOL_RESULT_TOO_LONG>", truncated: true, originalBytes: 0 }],
    }]);
  });

  it("实时工具结果复用同一投影且保留结果外层字段", () => {
    expect(projectSessionToolResult({
      content: [{ type: "image", data: "aGVsbG8=" }],
      details: { source: "read" },
    })).toEqual({
      content: [{ type: "image", data: "<IMAGE_BASE64>", originalBytes: 8 }],
      details: { source: "read" },
    });
  });

  it("固定脱敏 Assistant 错误且不修改原消息", () => {
    const original = [{
      role: "assistant",
      stopReason: "error",
      errorMessage: "Bearer clearly-fake-token https://fake-user@example.invalid /fake/private/path vendor-body",
    }];
    const before = structuredClone(original);

    const projected = projectSessionMessages(original);

    expect(projected).toEqual([{
      role: "assistant",
      stopReason: "error",
      errorMessage: MODEL_REQUEST_FAILED_MESSAGE,
    }]);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("clearly-fake-token");
    expect(serialized).not.toContain("fake-user");
    expect(serialized).not.toContain("/fake/private/path");
    expect(serialized).not.toContain("vendor-body");
    expect(original).toEqual(before);
  });

  it("固定长度截断提示并保留已有回答", () => {
    expect(projectSessionMessages([{
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: "partial answer" }],
      errorMessage: "untrusted truncation detail",
    }])).toEqual([{
      role: "assistant",
      stopReason: "length",
      content: [{ type: "text", text: "partial answer" }],
      errorMessage: MODEL_RESPONSE_TRUNCATED_MESSAGE,
    }]);
  });

  it("隐藏内部问题响应协议但保留同一用户消息的普通正文", () => {
    const protocol = compileQuestionResponseProtocol({
      resolutionId: "resolution-1",
      questionRecordId: "record-1",
      status: "discarded",
      discardReason: "new_message",
      answers: [],
      unansweredQuestionIds: ["question-1"],
    });

    expect(projectSessionMessages([
      { role: "user", content: protocol },
      { role: "user", content: `${protocol}\n\n请改做另一件事` },
      { role: "user", content: [{ type: "text", text: `${protocol}\n\n保留数组正文` }] },
    ])).toEqual([
      { role: "user", content: "" },
      { role: "user", content: "请改做另一件事" },
      { role: "user", content: [{ type: "text", text: "保留数组正文" }] },
    ]);
  });
});
