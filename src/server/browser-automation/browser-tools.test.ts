import { describe, expect, it, vi } from "vitest";

import { BROWSER_TOOL_NAMES, createBrowserTools } from "./browser-tools";
import { CAPABILITY_TOOL_CATALOG, DEFAULT_AGENT_TOOL_NAMES } from "../../shared/tool-catalog";

/** 九个工具保持简单根 Schema，并将结构化策略错误直接交给 Agent。 */
describe("浏览器 Pi 工具", () => {
  it("注册精确九个 object 根 Schema", () => {
    const tools = createBrowserTools({ sessionId: "session-a" }, { execute: vi.fn(async () => ({ ok: true })) });
    expect(tools.map((tool) => tool.name)).toEqual(BROWSER_TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.parameters).not.toHaveProperty("anyOf");
      expect(tool.parameters).not.toHaveProperty("oneOf");
      expect(tool.parameters).not.toHaveProperty("allOf");
    }
  });

  it("目录含九项且默认只授权六项只读浏览工具", () => {
    expect(CAPABILITY_TOOL_CATALOG.filter(({ name }) => name.startsWith("browser_")).map(({ name }) => name)).toEqual(BROWSER_TOOL_NAMES);
    expect(DEFAULT_AGENT_TOOL_NAMES).toEqual(expect.arrayContaining(BROWSER_TOOL_NAMES.slice(0, 6)));
    expect(DEFAULT_AGENT_TOOL_NAMES).not.toEqual(expect.arrayContaining(BROWSER_TOOL_NAMES.slice(6)));
  });

  it("把 SDK 的 AbortSignal 和排队更新传给服务", async () => {
    const execute = vi.fn(async () => ({ title: "Example" }));
    const [open] = createBrowserTools({ sessionId: "session-a" }, { execute });
    const controller = new AbortController();
    const onUpdate = vi.fn();
    await open!.execute("call-a", { url: "https://example.com" }, controller.signal, onUpdate, {} as never);
    expect(execute).toHaveBeenCalledWith(
      { sessionId: "session-a" },
      { type: "open", target: { kind: "url", url: "https://example.com" }, newPage: false },
      controller.signal,
      expect.any(Function),
    );
  });
});
