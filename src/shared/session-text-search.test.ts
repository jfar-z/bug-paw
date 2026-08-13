import { describe, expect, it } from "vitest";

import {
  buildSessionTextSnippet,
  extractVisibleSessionText,
} from "./session-text-search";

describe("会话可见文本", () => {
  it("移除用户消息中的附件与引用协议", () => {
    const message = extractVisibleSessionText({
      role: "user",
      __piEntryId: "user-1",
      timestamp: 1_786_579_200_000,
      content: [
        {
          type: "text",
          text: [
            "请分析这份资料",
            '<agent_references version="1" type="file" path="attachments/a.pdf" kind="file"/>',
            '<pi_agent_files version="1">',
            '{"files":[{"path":"attachments/a.pdf"}]}',
            "</pi_agent_files>",
          ].join("\n"),
        },
        { type: "image", data: "不可检索的附件内容" },
      ],
    });

    expect(message).toEqual({
      entryId: "user-1",
      role: "user",
      text: "请分析这份资料",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
  });

  it("只拼接助手最终文本并排除思考与工具参数", () => {
    expect(extractVisibleSessionText({
      role: "assistant",
      __piEntryId: "assistant-1",
      content: [
        { type: "thinking", thinking: "不可检索的推理" },
        { type: "text", text: "第一段结论" },
        { type: "toolCall", id: "tool-1", name: "read", arguments: { query: "不可检索" } },
        { type: "text", text: "第二段结论" },
      ],
    })).toEqual({
      entryId: "assistant-1",
      role: "assistant",
      text: "第一段结论\n\n第二段结论",
    });

    expect(extractVisibleSessionText({
      role: "toolResult",
      __piEntryId: "tool-1",
      content: [{ type: "text", text: "不可检索的工具结果" }],
    })).toBeUndefined();
  });

  it("缺少稳定 entry ID 或没有可见正文时不生成记录", () => {
    expect(extractVisibleSessionText({ role: "user", content: "没有 ID" })).toBeUndefined();
    expect(extractVisibleSessionText({
      role: "assistant",
      __piEntryId: "assistant-empty",
      content: [{ type: "thinking", thinking: "只有思考" }],
    })).toBeUndefined();
  });
});

describe("搜索片段", () => {
  it("大小写不敏感地返回片段内全部连续命中", () => {
    expect(buildSessionTextSnippet("Alpha beta ALPHA", "alpha")).toEqual({
      snippet: "Alpha beta ALPHA",
      matchRanges: [{ start: 0, end: 5 }, { start: 11, end: 16 }],
    });
  });

  it("不把正则字符解释为表达式", () => {
    expect(buildSessionTextSnippet("a.b A.B ab", "a.b").matchRanges).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ]);
  });

  it("大小写归一化改变长度时仍返回原文本索引", () => {
    expect(buildSessionTextSnippet("İx X", "x")).toEqual({
      snippet: "İx X",
      matchRanges: [{ start: 1, end: 2 }, { start: 3, end: 4 }],
    });
  });

  it("截断长文本后仍以最终片段坐标返回范围且不切断代理对", () => {
    const text = `${"前".repeat(200)}😀Needle${"后".repeat(200)}`;
    const result = buildSessionTextSnippet(text, "needle");

    expect(result.snippet.length).toBeLessThanOrEqual(320);
    expect(result.snippet).toContain("😀Needle");
    expect(result.snippet).not.toMatch(/^[\uDC00-\uDFFF]/u);
    expect(result.snippet).not.toMatch(/[\uD800-\uDBFF]$/u);
    expect(result.matchRanges.map(({ start, end }) => result.snippet.slice(start, end)))
      .toEqual(["Needle"]);
  });

  it("空查询或没有命中时返回空范围", () => {
    expect(buildSessionTextSnippet("正文", "")).toEqual({ snippet: "", matchRanges: [] });
    expect(buildSessionTextSnippet("正文", "missing")).toEqual({ snippet: "", matchRanges: [] });
  });
});
