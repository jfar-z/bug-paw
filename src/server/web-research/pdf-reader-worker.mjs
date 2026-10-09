import { PDFParse } from "pdf-parse";

/** 子进程只处理安全客户端已下载的字节，绝不自行访问 URL 或文件。 */
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
let parser;
try {
  parser = new PDFParse({ data: Buffer.from(input.data, "base64"), verbosity: 0, isEvalSupported: false });
  const info = await parser.getInfo();
  if (info.total > 300) throw Object.assign(new Error(), { code: "PDF_PAGE_LIMIT" });
  const start = input.action === "inspect" ? 1 : input.startPage;
  const end = input.action === "inspect" ? 1 : input.endPage;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > info.total || end - start >= 20) {
    throw Object.assign(new Error(), { code: "PDF_PAGE_OUT_OF_RANGE" });
  }
  const pages = [];
  let truncated = false;
  let remaining = input.maxCharacters;
  let image;
  const pagesWithoutText = [];
  if (input.action === "render") {
    const dimensions = await parser.getInfo({ parsePageInfo: true, partial: [start] });
    const page = dimensions.pages[0];
    if (!page || page.width <= 0 || page.height <= 0) throw Object.assign(new Error(), { code: "PDF_RENDER_FAILED" });
    const width = Math.min(1000, Math.floor(Math.sqrt(2_000_000 * page.width / page.height)));
    if (width < 1) throw Object.assign(new Error(), { code: "PDF_RENDER_FAILED" });
    const result = await parser.getScreenshot({ partial: [start], desiredWidth: width, imageDataUrl: false, imageBuffer: true });
    const shot = result.pages[0];
    if (!shot || shot.data.length > 2 * 1024 * 1024) throw Object.assign(new Error(), { code: "PDF_OUTPUT_LIMIT" });
    image = { page: start, data: Buffer.from(shot.data).toString("base64"), mimeType: "image/png", width: shot.width, height: shot.height };
  } else {
    for (let page = start; page <= end; page += 1) {
      const result = await parser.getText({ partial: [page], pageJoiner: "" });
      const original = result.pages[0]?.text.trim() ?? "";
      if (!original) pagesWithoutText.push(page);
      let text = original;
      if (input.action === "find") {
        const position = original.toLocaleLowerCase().indexOf(input.query.toLocaleLowerCase());
        if (position < 0) continue;
        text = original.slice(Math.max(0, position - 350), position + input.query.length + 650);
      }
      if (text.length > remaining) truncated = true;
      pages.push({ page, text: text.slice(0, Math.max(0, remaining)), hasText: Boolean(original), truncated: text.length > remaining });
      remaining -= text.length;
      if (remaining <= 0) { truncated ||= page < end; break; }
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, value: { title: String(info.info?.Title ?? "").slice(0, 500), totalPages: info.total, pages, pagesWithoutText, scannedRange: { start, end: input.action === "find" && truncated ? pages.at(-1)?.page ?? start : end }, truncated, ...(image ? { image } : {}) } }));
} catch (error) {
  const known = ["PDF_PAGE_LIMIT", "PDF_PAGE_OUT_OF_RANGE", "PDF_RENDER_FAILED", "PDF_OUTPUT_LIMIT"];
  const code = known.includes(error?.code) ? error.code : error?.name === "PasswordException" ? "PDF_PASSWORD_REQUIRED" : "PDF_PARSE_FAILED";
  process.stdout.write(JSON.stringify({ ok: false, code }));
} finally {
  if (parser) await parser.destroy();
}
