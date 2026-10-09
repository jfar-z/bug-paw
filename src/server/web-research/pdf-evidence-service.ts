import type { WebResearchConfigDocument } from "../../shared/web-research-contracts";
import { parsePdfEvidence, validatePdfInput, type PdfReadInput, type ParsedPdfEvidence } from "./pdf-reader";
import { WebEvidenceError, WebEvidenceState } from "./web-evidence-state";

/** 公网 PDF 取证：下载和解析分开缓存，限制服务端解析并发。 */
export class PdfEvidenceService {
  private activeParsers = 0;

  constructor(private readonly dependencies: {
    readConfig(): Promise<WebResearchConfigDocument>;
    fetchPdf(url: string, config: WebResearchConfigDocument["config"], signal?: AbortSignal): Promise<{ finalUrl: string; body: Buffer }>;
    parse?: typeof parsePdfEvidence;
  }) {}

  /** 仅处理明确授权的 URL；缓存命中仍先检查当前全局安全策略。 */
  async read(input: PdfReadInput, state = new WebEvidenceState(), signal?: AbortSignal): Promise<ParsedPdfEvidence & { requestedUrl: string; finalUrl: string; fetchedAt: string }> {
    validatePdfInput(input);
    const { config } = await this.dependencies.readConfig();
    if (!config.enabled) throw new WebEvidenceError("WEB_RESEARCH_DISABLED", "联网检索全局能力未启用");
    signal?.throwIfAborted();
    const policy = JSON.stringify(config);
    const file = await state.load("pdf", input.url, policy, async () => {
      const result = await this.dependencies.fetchPdf(input.url, { ...config, maxResponseBytes: Math.min(config.maxResponseBytes, 4 * 1024 * 1024) }, signal);
      return { value: { ...result, fetchedAt: new Date().toISOString() }, bytes: result.body.length };
    });
    const parameters = { ...input, maxCharacters: Math.min(input.maxCharacters ?? 6000, config.maxTextLength, 20_000) };
    const result = await state.load(`pdf-parse:${JSON.stringify(parameters)}`, input.url, policy, async () => {
      signal?.throwIfAborted();
      if (this.activeParsers >= 2) throw new WebEvidenceError("PDF_PARSER_BUSY", "PDF 隔离解析并发已达到两路上限", true, { phase: "pdf_parse" });
      this.activeParsers += 1;
      try {
        const value = await (this.dependencies.parse ?? parsePdfEvidence)(file.body, parameters, signal);
        return { value, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") };
      } finally { this.activeParsers -= 1; }
    });
    signal?.throwIfAborted();
    return { ...result, requestedUrl: input.url, finalUrl: file.finalUrl, fetchedAt: file.fetchedAt };
  }
}
