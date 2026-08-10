import { describe, expect, it } from "vitest";

import { chunkKnowledgeText } from "./chunker";

describe("chunkKnowledgeText", () => {
  it("优先在中文句末切片并保留相邻片段的重叠上下文", () => {
    const chunks = chunkKnowledgeText("第一段用于说明规则。第二段用于说明例外。第三段用于说明审批流程。", { maxLength: 14, overlap: 4 });

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
    expect(chunks[0]?.text).toContain("第一段");
    expect(chunks[1]?.text).toContain("第二段");
    expect(chunks[1]?.text).toContain("规则。");
  });
});
