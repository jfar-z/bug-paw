// @vitest-environment node

import { describe, expect, it } from "vitest";

import { resolveEffectiveRetrievalCapabilities } from "./agent-retrieval-capabilities";

describe("Agent 有效检索能力", () => {
  it("仅暴露实际已授权且全局可用的能力", () => {
    expect(resolveEffectiveRetrievalCapabilities({
      allowedTools: ["knowledge_search", "web_search", "web_read"],
      webResearchEnabled: false,
    })).toEqual({
      knowledgeSearch: true,
      knowledgeRead: false,
      webSearch: false,
      webRead: false,
    });
  });

  it("支持知识库和联网能力的部分授权", () => {
    expect(resolveEffectiveRetrievalCapabilities({
      allowedTools: ["knowledge_read", "web_read"],
      webResearchEnabled: true,
    })).toEqual({
      knowledgeSearch: false,
      knowledgeRead: true,
      webSearch: false,
      webRead: true,
    });
  });
});
