import { describe, expect, it } from "vitest";

import { createWebOpenTool, createWebSearchTool } from "./web-research-tools";

describe("联网搜索 Pi 工具", () => {
  it("web_search 返回结构化来源", async () => {
    const tool = createWebSearchTool({ search: async () => ({ results: [{ title: "标题", url: "https://example.com", snippet: "摘要", source: "搜索源" }] }) });
    const result = await tool.execute("call", { query: "测试", count: 1 }, undefined, undefined, {} as never);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("https://example.com") });
  });

  it("web_open 将可纠正错误返回给 Agent", async () => {
    const tool = createWebOpenTool({ open: async () => { throw new Error("该网页地址不符合当前安全策略"); } });
    const result = await tool.execute("call", { url: "http://127.0.0.1" }, undefined, undefined, {} as never);
    const content = result.content[0];
    expect(content.type).toBe("text");
    expect(JSON.parse((content as { text: string }).text)).toEqual({ error: {
      code: "WEB_FETCH_FAILED",
      message: "该网页地址不符合当前安全策略",
      suggestion: "请稍后重试，或更换其他公开来源。",
    } });
  });
});
