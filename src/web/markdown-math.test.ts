import { describe, expect, it } from "vitest";
import { normalizeMathDelimiters } from "./markdown-math";

describe("normalizeMathDelimiters", () => {
  it("将反斜杠行内与块级数学定界符转换为 remark-math 语法", () => {
    expect(normalizeMathDelimiters(String.raw`分布 \(\mathcal{N}(\mu, \sigma^2)\)`))
      .toBe(String.raw`分布 $\mathcal{N}(\mu, \sigma^2)$`);
    expect(normalizeMathDelimiters("前文\n\\[\nx^2\n\\]\n后文"))
      .toBe("前文\n$$\nx^2\n$$\n后文");
  });

  it("不转换行内代码、围栏代码和未闭合定界符", () => {
    const markdown = [
      "行内代码 `\\(x\\)`",
      "",
      "```md",
      String.raw`\[x^2\]`,
      "```",
      "",
      String.raw`未闭合 \(x`,
    ].join("\n");

    expect(normalizeMathDelimiters(markdown)).toBe(markdown);
  });

  it("不转换显式转义的双反斜杠定界符", () => {
    const markdown = String.raw`保留 \\(x\\)`;

    expect(normalizeMathDelimiters(markdown)).toBe(markdown);
  });
});
