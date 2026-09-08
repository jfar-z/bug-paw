import { classifyDataFileLink, dataFileLinkMediaKind } from "./workspace-links";
import { describe, expect, it } from "vitest";

describe("Markdown 文件链接分类", () => {
  it.each([
    ["outputs/result.mp4", { kind: "data-file", path: "outputs/result.mp4" }],
    ["/data/shared/report.pdf", { kind: "data-file", path: "/data/shared/report.pdf" }],
    ["file:///data/shared/image.png", { kind: "data-file", path: "file:///data/shared/image.png" }],
    ["FILE:///data/shared/image.png", { kind: "data-file", path: "FILE:///data/shared/image.png" }],
  ])("将 %s 识别为文件链接", (href, expected) => {
    expect(classifyDataFileLink(href)).toEqual(expected);
  });

  it.each(["https://example.com/a.png", "mailto:test@example.com", "/settings", "#section"])("保留普通链接 %s", (href) => {
    expect(classifyDataFileLink(href)).toEqual({ kind: "passthrough" });
  });

  it("按忽略大小写且去除 query/hash 的后缀选择图标", () => {
    expect(dataFileLinkMediaKind("OUTPUTS/DEMO.MP4?download=1#preview")).toBe("video");
    expect(dataFileLinkMediaKind("/data/report.PDF#page=2")).toBe("pdf");
    expect(dataFileLinkMediaKind("notes/readme.md")).toBe("text");
    expect(dataFileLinkMediaKind("archive.zip")).toBeUndefined();
    expect(dataFileLinkMediaKind("https://example.com/image.png")).toBeUndefined();
  });
});
