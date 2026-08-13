// @vitest-environment node

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import registerEvaluationTools from "./extension";

const originalCaseId = process.env.DEEP_RESEARCH_EVAL_CASE;

function captureTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  registerEvaluationTools({
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  } as ExtensionAPI);
  return tools;
}

async function executeTool(tool: ToolDefinition, params: object) {
  return tool.execute("test-call", params as never, undefined, undefined, {} as never);
}

beforeEach(() => {
  process.env.DEEP_RESEARCH_EVAL_CASE = "syndication-pollution";
});

afterEach(() => {
  if (originalCaseId === undefined) {
    delete process.env.DEEP_RESEARCH_EVAL_CASE;
  } else {
    process.env.DEEP_RESEARCH_EVAL_CASE = originalCaseId;
  }
});

describe("深度研究评测扩展", () => {
  it("注册三个根对象参数工具", () => {
    const tools = captureTools();

    expect([...tools.keys()]).toEqual(["read", "web_search", "web_read"]);
    for (const tool of tools.values()) {
      const schema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
      expect(schema).not.toHaveProperty("allOf");
    }
  });

  it("只允许 read 读取被测 Skill 正文", async () => {
    const read = captureTools().get("read");
    expect(read).toBeDefined();

    const result = await executeTool(read!, { path: "src/server/skills/deep-research/SKILL.md" });
    expect(JSON.stringify(result)).toContain("禁止证据升级");
    await expect(executeTool(read!, { path: "scripts/deep-research-eval/cases.ts" })).rejects.toThrow(
      "评测 read 仅允许读取 deep-research Skill",
    );
  });

  it("真实工具结果不泄露评测者 oracle", async () => {
    const tools = captureTools();
    const search = await executeTool(tools.get("web_search")!, { query: "Luma 72%" });
    const page = await executeTool(tools.get("web_read")!, { url: "https://copy.example/luma-one" });
    const serialized = JSON.stringify({ search, page });

    expect(serialized).not.toContain("sourceFamilies");
    expect(serialized).not.toContain("passCriteria");
    expect(serialized).not.toContain("traps");
  });

  it("未知案例和未知页面作为工具错误抛出", async () => {
    const readPage = captureTools().get("web_read")!;
    await expect(executeTool(readPage, { url: "https://unknown.example/page" })).rejects.toThrow("评测页面不存在");

    process.env.DEEP_RESEARCH_EVAL_CASE = "unknown-case";
    const search = captureTools().get("web_search")!;
    await expect(executeTool(search, { query: "anything" })).rejects.toThrow("评测案例不存在");
  });
});
