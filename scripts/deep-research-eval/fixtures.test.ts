import { describe, expect, it } from "vitest";
import { getEvaluationCase } from "./cases";
import { readFixture, searchFixture } from "./fixtures";

describe("深度研究回归语料", () => {
  it("覆盖七类研究失败模式且标识唯一", () => {
    const ids = [
      "current-product",
      "business-causality",
      "syndication-pollution",
      "official-community-conflict",
      "art-interpretation",
      "insufficient-evidence",
      "historical-current",
    ];

    expect(ids.map((id) => getEvaluationCase(id).id)).toEqual(ids);
  });

  it("搜索只返回摘要，页面读取返回可核对正文", () => {
    const result = searchFixture("current-product", "当前开放权重");

    expect(result.results.length).toBeGreaterThan(1);
    expect(result).not.toHaveProperty("sourceFamilies");
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        title: expect.any(String),
        url: expect.stringMatching(/^https:\/\//),
        snippet: expect.any(String),
      }),
    );

    const page = readFixture("current-product", result.results[0].url);

    expect(page.content.length).toBeGreaterThan(result.results[0].snippet.length);
    expect(page).toEqual(
      expect.objectContaining({
        publishedAt: expect.any(String),
        content: expect.any(String),
      }),
    );
  });

  it("评测器保留来源链标准答案但不会通过搜索结果泄露", () => {
    const evaluationCase = getEvaluationCase("syndication-pollution");
    const result = searchFixture(evaluationCase.id, "Luma 72% 来源");

    expect(new Set(Object.values(evaluationCase.sourceFamilies)).size).toBeLessThan(result.results.length);
    expect(JSON.stringify(result)).not.toContain("anonymous-luma-post");
  });

  it("拒绝跨案例或不存在的页面地址", () => {
    expect(() => readFixture("current-product", "https://fixtures.invalid/unknown")).toThrow(
      "评测页面不存在",
    );
  });
});
