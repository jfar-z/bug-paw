import { SYSTEM_LIMITS } from "../core/limits";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** 可供知识库切片的已解析文本。 */
export type ParsedKnowledgeDocument =
  | { status: "ready"; text: string; pages: Array<{ page: number; text: string }> }
  | { status: "needs_ocr"; text: ""; pages: [] };

/** 待解析的原始资料。 */
export interface KnowledgeDocumentSource {
  mediaType: string;
  path: string;
  signal?: AbortSignal;
}

/**
 * 将本期支持的资料格式转换为知识库文本。
 *
 * @param source 原始资料内容和已识别媒体类型
 */
export async function parseKnowledgeDocument(source: KnowledgeDocumentSource): Promise<ParsedKnowledgeDocument> {
  source.signal?.throwIfAborted();
  if (source.mediaType === "text/plain" || source.mediaType === "text/markdown") {
    const content = await readFile(source.path, { signal: source.signal });
    return readyText(content.toString("utf8"));
  }
  if (source.mediaType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    || source.mediaType === "application/pdf") {
    return parseInChildProcess(source);
  }
  throw new TypeError("不支持的知识库资料格式");
}

/** 清理提取文本，空内容统一标识为需要 OCR。 */
function readyText(value: string): ParsedKnowledgeDocument {
  if (value.length > SYSTEM_LIMITS.knowledgeTextCharacters) {
    throw new RangeError("资料解析后的文本超过系统上限");
  }
  const text = value.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").trim();
  return text ? { status: "ready", text, pages: [{ page: 1, text }] } : { status: "needs_ocr", text: "", pages: [] };
}

/**
 * 在受操作系统地址空间和 V8 堆双重限制的子进程中解析压缩文档。
 *
 * @param source 已通过上传校验的资料路径和类型
 */
function parseInChildProcess(source: KnowledgeDocumentSource): Promise<ParsedKnowledgeDocument> {
  return new Promise((resolve, reject) => {
    const parserPath = fileURLToPath(new URL("./document-parser-worker.mjs", import.meta.url));
    const child = spawn("/usr/bin/prlimit", [
      "--as=2147483648",
      "--",
      process.execPath,
      "--max-old-space-size=128",
      parserPath,
    ], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let settled = false;
    let outputBytes = 0;
    const output: Buffer[] = [];
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.signal?.removeEventListener("abort", abort);
      operation();
    };
    const abort = () => {
      child.kill("SIGKILL");
      finish(() => reject(source.signal?.reason ?? new DOMException("解析已取消", "AbortError")));
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new RangeError("资料解析超时")));
    }, SYSTEM_LIMITS.knowledgeParseTimeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > SYSTEM_LIMITS.knowledgeParserOutputBytes) {
        child.kill("SIGKILL");
        finish(() => reject(new RangeError("资料解析结果超过系统上限")));
        return;
      }
      output.push(chunk);
    });
    child.stdout.once("error", () => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("资料解析结果读取失败")));
    });
    child.once("error", () => finish(() => reject(new Error("资料解析子进程启动失败"))));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(() => reject(new RangeError("资料解析超过资源预算")));
        return;
      }
      finish(() => {
        const message = parseChildMessage(Buffer.concat(output).toString("utf8"));
        if (isChildSuccess(message)) resolve(message.value);
        else reject(new Error(isChildFailure(message) ? message.error : "资料解析子进程返回无效结果"));
      });
    });
    // 子进程提前退出时 stdin 可能产生 EPIPE，错误由 close 事件统一归类。
    child.stdin.on("error", () => undefined);
    source.signal?.addEventListener("abort", abort, { once: true });
    if (source.signal?.aborted) {
      abort();
      return;
    }
    child.stdin.end(JSON.stringify({
      path: source.path,
      mediaType: source.mediaType,
      limits: {
        textCharacters: SYSTEM_LIMITS.knowledgeTextCharacters,
        docxEntries: SYSTEM_LIMITS.knowledgeDocxEntries,
        docxUncompressedBytes: SYSTEM_LIMITS.knowledgeDocxUncompressedBytes,
        pdfPages: SYSTEM_LIMITS.knowledgePdfPages,
      },
    }));
  });
}

/** 将子进程输出解析为未知消息，格式错误由调用方统一拒绝。 */
function parseChildMessage(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** 验证子进程成功消息，禁止信任进程边界外的未知对象。 */
function isChildSuccess(value: unknown): value is { ok: true; value: ParsedKnowledgeDocument } {
  if (!value || typeof value !== "object" || !("ok" in value) || value.ok !== true || !("value" in value)) return false;
  return isParsedKnowledgeDocument(value.value);
}

/** 验证子进程失败消息。 */
function isChildFailure(value: unknown): value is { ok: false; error: string } {
  return Boolean(value && typeof value === "object" && "ok" in value && value.ok === false
    && "error" in value && typeof value.error === "string" && value.error.length <= 300);
}

/**
 * 完整校验解析进程返回的文档结构和工作量上限。
 *
 * @param value 进程边界外的未知文档
 */
export function isParsedKnowledgeDocument(value: unknown): value is ParsedKnowledgeDocument {
  if (!value || typeof value !== "object" || !("status" in value) || !("text" in value) || !("pages" in value)) {
    return false;
  }
  const document = value as { status: unknown; text: unknown; pages: unknown };
  if (document.status === "needs_ocr") {
    return document.text === "" && Array.isArray(document.pages) && document.pages.length === 0;
  }
  if (document.status !== "ready" || typeof document.text !== "string"
    || document.text.length === 0 || document.text.length > SYSTEM_LIMITS.knowledgeTextCharacters
    || !Array.isArray(document.pages) || document.pages.length === 0
    || document.pages.length > SYSTEM_LIMITS.knowledgePdfPages) {
    return false;
  }
  let pageCharacters = 0;
  for (const page of document.pages) {
    if (!page || typeof page !== "object" || !("page" in page) || !("text" in page)
      || !Number.isInteger(page.page) || page.page < 1 || page.page > SYSTEM_LIMITS.knowledgePdfPages
      || typeof page.text !== "string") {
      return false;
    }
    pageCharacters += page.text.length;
    if (pageCharacters > SYSTEM_LIMITS.knowledgeTextCharacters) return false;
  }
  return true;
}
