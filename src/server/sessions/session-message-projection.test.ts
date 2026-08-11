import { describe, expect, it } from "vitest";

import { projectSessionMessages } from "./session-message-projection";

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
});
