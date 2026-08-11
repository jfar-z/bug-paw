import { describe, expect, it } from "vitest";

import { chunkKnowledgePages, chunkKnowledgeText } from "./chunker";

describe("chunkKnowledgeText", () => {
  it("优先在中文句末切片并保留相邻片段的重叠上下文", () => {
    const chunks = chunkKnowledgeText("第一段用于说明规则。第二段用于说明例外。第三段用于说明审批流程。", { maxLength: 14, overlap: 4 });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(chunks[0]?.text).toContain("第一段");
    expect(chunks[1]?.text).toContain("第二段");
    expect(chunks[1]?.text).toContain("规则。");
  });

  it("按解析页切片并保留页码", () => {
    const chunks = chunkKnowledgePages([
      { page: 1, text: "第一页内容。" },
      { page: 2, text: "第二页内容。" },
    ], { maxLength: 20, overlap: 4 });

    expect(chunks).toEqual([
      { index: 0, text: "第一页内容。", page: 1, section: null },
      { index: 1, text: "第二页内容。", page: 2, section: null },
    ]);
  });
});
