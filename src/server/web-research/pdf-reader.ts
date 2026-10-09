import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { WebEvidenceError } from "./web-evidence-state";

/** 按明确操作读取的 PDF 物理页码窗口。 */
export interface PdfReadInput {
  action: "inspect" | "read" | "find" | "render";
  url: string;
  startPage: number | null;
  endPage: number | null;
  query: string | null;
  maxCharacters?: number;
}

/** 子进程返回的有限 PDF 证据和可选页面图片。 */
export interface ParsedPdfEvidence {
  title: string;
  totalPages: number;
  pages: Array<{ page: number; text: string; hasText: boolean; truncated: boolean }>;
  pagesWithoutText: number[];
  scannedRange: { start: number; end: number };
  truncated: boolean;
  image?: { page: number; data: string; mimeType: "image/png"; width: number; height: number };
}

/** 校验组合参数，避免空参数、猜测页码或无限范围解析。 */
export function validatePdfInput(input: PdfReadInput): void {
  const inspect = input.action === "inspect";
  if (inspect && (input.startPage !== null || input.endPage !== null || input.query !== null)) {
    throw new WebEvidenceError("PDF_INVALID_PARAMETERS", "inspect 必须传 startPage=null、endPage=null、query=null");
  }
  if (!inspect && (!Number.isInteger(input.startPage) || !Number.isInteger(input.endPage) || input.startPage! < 1 || input.endPage! < input.startPage! || input.endPage! - input.startPage! >= 20)) {
    throw new WebEvidenceError("PDF_INVALID_PARAMETERS", "PDF 读取须提供有效页码范围，每次最多 20 页");
  }
  if (input.action === "render" && input.startPage !== input.endPage) throw new WebEvidenceError("PDF_INVALID_PARAMETERS", "PDF 页面渲染每次仅支持一页");
  if ((input.action === "find" && !input.query?.trim()) || (input.action !== "find" && input.query !== null)) {
    throw new WebEvidenceError("PDF_INVALID_PARAMETERS", "find 必须提供关键词，其他操作必须传 query=null");
  }
}

/** 脱敏解析错误；不回显 PDF 内嵌内容、底层堆栈或本机路径。 */
export function pdfError(code: string): WebEvidenceError {
  const messages: Record<string, string> = {
    PDF_PAGE_LIMIT: "PDF 总页数超过 300 页解析上限",
    PDF_PAGE_OUT_OF_RANGE: "PDF 页码超出文档范围或单次页数上限",
    PDF_RENDER_FAILED: "PDF 指定页面渲染失败",
    PDF_OUTPUT_LIMIT: "PDF 解析或图片输出超过资源上限",
    PDF_PASSWORD_REQUIRED: "PDF 需要密码，公开 PDF 工具不接收密码",
    PDF_PARSE_FAILED: "PDF 文档结构解析失败",
    PDF_PARSE_TIMEOUT: "PDF 解析超出 15 秒时间预算",
    PDF_PARSER_UNAVAILABLE: "PDF 隔离解析进程启动失败",
    PDF_PARSE_CANCELLED: "PDF 解析已取消",
  };
  return new WebEvidenceError(code in messages ? code : "PDF_PARSE_FAILED", messages[code] ?? messages.PDF_PARSE_FAILED!, false, { phase: "pdf_parse" });
}

/** 在有内存、时间和输出限制的子进程内解析，取消时终止进程。 */
export function parsePdfEvidence(data: Buffer, input: PdfReadInput, signal?: AbortSignal): Promise<ParsedPdfEvidence> {
  validatePdfInput(input);
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/prlimit", ["--as=4294967296", "--", process.execPath, "--max-old-space-size=256", fileURLToPath(new URL("./pdf-reader-worker.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      operation();
    };
    const stop = (code: string) => { child.kill("SIGKILL"); finish(() => reject(pdfError(code))); };
    const abort = () => stop("PDF_PARSE_CANCELLED");
    const timer = setTimeout(() => stop("PDF_PARSE_TIMEOUT"), 15_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) { stop("PDF_OUTPUT_LIMIT"); return; }
      chunks.push(chunk);
    });
    child.stdout.on("error", () => stop("PDF_PARSE_FAILED"));
    child.once("error", () => stop("PDF_PARSER_UNAVAILABLE"));
    child.once("close", (code) => finish(() => {
      if (code !== 0) { reject(pdfError("PDF_PARSE_FAILED")); return; }
      try {
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!message.ok) { reject(pdfError(String(message.code))); return; }
        const value = message.value as ParsedPdfEvidence;
        if (!Number.isInteger(value.totalPages) || value.totalPages < 1 || value.totalPages > 300 || !Array.isArray(value.pages) || value.pages.length > 20
          || value.pages.some((page) => !Number.isInteger(page.page) || page.page < 1 || page.page > value.totalPages || typeof page.text !== "string")
          || value.pages.reduce((sum, page) => sum + page.text.length, 0) > (input.maxCharacters ?? 6000)) {
          reject(pdfError("PDF_PARSE_FAILED")); return;
        }
        resolve(value);
      } catch { reject(pdfError("PDF_PARSE_FAILED")); }
    }));
    // EPIPE 不另报成功，实际失败由进程 close 统一处理。
    child.stdin.on("error", () => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.stdin.end(JSON.stringify({ ...input, maxCharacters: Math.min(input.maxCharacters ?? 6000, 20_000), data: data.toString("base64") }));
  });
}
