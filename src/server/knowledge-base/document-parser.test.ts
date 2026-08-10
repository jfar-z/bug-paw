// @vitest-environment node

import JSZip from "jszip";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isParsedKnowledgeDocument, parseKnowledgeDocument } from "./document-parser";

describe("parseKnowledgeDocument", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("解析 UTF-8 文本和 DOCX 的正文", async () => {
    await expect(parseKnowledgeDocument({
      mediaType: "text/plain",
      path: await sourceFile(Buffer.from("知识库支持中文检索", "utf8")),
    })).resolves.toMatchObject({ status: "ready", text: "知识库支持中文检索" });

    await expect(parseKnowledgeDocument({
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      path: await sourceFile(await createDocx("DOCX 正文内容")),
    })).resolves.toMatchObject({ status: "ready", text: expect.stringContaining("DOCX 正文内容") });
  });

  it("将 Markdown 作为 UTF-8 文本保留标题和正文", async () => {
    await expect(parseKnowledgeDocument({
      mediaType: "text/markdown",
      path: await sourceFile(Buffer.from("# 标题\n\n正文内容", "utf8")),
    })).resolves.toMatchObject({ status: "ready", text: "# 标题\n\n正文内容" });
  });

  it("将没有文字层的 PDF 标记为需要 OCR", async () => {
    await expect(parseKnowledgeDocument({
      mediaType: "application/pdf",
      path: await sourceFile(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n", "ascii")),
    })).resolves.toMatchObject({ status: "needs_ocr", text: "", pages: [] });
  });

  it("拒绝子进程边界上的畸形、超限和不一致文档", () => {
    expect(isParsedKnowledgeDocument({ status: "ready", text: "正文", pages: [{ page: 1, text: "正文" }] })).toBe(true);
    expect(isParsedKnowledgeDocument({ status: "needs_ocr", text: "", pages: [] })).toBe(true);
    expect(isParsedKnowledgeDocument({ status: "ready", pages: [] })).toBe(false);
    expect(isParsedKnowledgeDocument({ status: "ready", text: "正文", pages: [] })).toBe(false);
    expect(isParsedKnowledgeDocument({ status: "ready", text: "正文", pages: [{ page: 0, text: "正文" }] })).toBe(false);
    expect(isParsedKnowledgeDocument({ status: "needs_ocr", text: "伪造正文", pages: [] })).toBe(false);
    expect(isParsedKnowledgeDocument({ status: "ready", text: "x".repeat(5_000_001), pages: [{ page: 1, text: "x" }] })).toBe(false);
  });

  /** 为解析器创建测试专用源文件。 */
  async function sourceFile(content: Buffer): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-document-parser-"));
    roots.push(root);
    const path = join(root, "source");
    await writeFile(path, content);
    return path;
  }
});

/** 创建仅包含一个段落的最小 DOCX 测试文件。 */
async function createDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>");
  zip.file("_rels/.rels", "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>");
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: "nodebuffer" });
}
