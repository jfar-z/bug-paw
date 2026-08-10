import { readFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";

import JSZip from "jszip";
import mammoth from "mammoth";
import { PDFParse } from "pdf-parse";

/** 子进程只接收服务端生成的路径和固定数值上限。 */
const input = JSON.parse(await readInput());

try {
  const content = await readFile(input.path);
  const value = input.mediaType === "application/pdf"
    ? await parsePdf(content)
    : await parseDocx(content);
  stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : "资料解析失败",
  }));
}

/** 读取父进程发送的单个 JSON 请求，避免通过命令行暴露资料路径。 */
async function readInput() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** 解压前通过中央目录拒绝 DOCX 压缩炸弹。 */
async function parseDocx(content) {
  const archive = await JSZip.loadAsync(content);
  const entries = Object.values(archive.files);
  if (entries.length > input.limits.docxEntries) throw new RangeError("DOCX 文件条目数量超过系统上限");
  const total = entries.reduce((bytes, entry) => bytes + (entry?._data?.uncompressedSize ?? 0), 0);
  if (total > input.limits.docxUncompressedBytes) throw new RangeError("DOCX 解压后内容超过系统上限");
  const result = await mammoth.extractRawText({ buffer: content });
  return readyText(result.value);
}

/** 按页提取并逐页检查累计字符数，避免先构造无上限的整本文本。 */
async function parsePdf(content) {
  const parser = new PDFParse({ data: content });
  try {
    const first = await parser.getText({ partial: [1], pageJoiner: "" });
    if (first.total > input.limits.pdfPages) throw new RangeError("PDF 页数超过系统上限");
    const pages = [first.pages[0]?.text ?? ""];
    let characters = pages[0].length;
    for (let page = 2; page <= first.total; page += 1) {
      const result = await parser.getText({ partial: [page], pageJoiner: "" });
      const text = result.pages[0]?.text ?? "";
      characters += text.length;
      if (characters > input.limits.textCharacters) throw new RangeError("资料解析后的文本超过系统上限");
      pages.push(text);
    }
    return readyText(pages.join("\n\n"));
  } catch (error) {
    if (error instanceof RangeError) throw error;
    // 扫描件和无可读文字层的 PDF 交由未来 OCR 流程处理。
    return { status: "needs_ocr", text: "", pages: [] };
  } finally {
    await parser.destroy();
  }
}

/** 规范化正文并执行最终字符上限。 */
function readyText(value) {
  if (value.length > input.limits.textCharacters) throw new RangeError("资料解析后的文本超过系统上限");
  const text = value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  return text
    ? { status: "ready", text, pages: [{ page: 1, text }] }
    : { status: "needs_ocr", text: "", pages: [] };
}
