import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  emptyResponse,
  okResponse,
  partialResponse,
  toPiToolResult,
  type ToolWarning,
} from "../retrieval/tool-response";
import type { WebReadInput, WebReadServiceResult, WebSearchServiceResult } from "./web-research-service";
import type { PdfEvidenceService } from "./pdf-evidence-service";
import { SearchRunState } from "./search-run-state";
import { WebEvidenceError, WebEvidenceState } from "./web-evidence-state";
import { evidenceError, researchWebEvidence } from "./web-research-evidence";

interface WebSearchToolService {
  search(input: { query: string; count?: number; site?: string; language?: string; timeRange?: string; signal?: AbortSignal }): Promise<WebSearchServiceResult>;
}

interface WebReadToolService {
  read(input: WebReadInput, state?: WebEvidenceState, signal?: AbortSignal): Promise<WebReadServiceResult>;
}

/** 创建搜索公开互联网的 Pi SDK 工具。 */
export function createWebSearchTool(service: WebSearchToolService) {
  return defineTool({
    name: "web_search",
    label: "联网搜索",
    description: "搜索公开互联网，返回规范化、去重后的标题、链接、摘要、来源引擎和发布时间。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      site: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
      language: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
      timeRange: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await service.search({ ...params, signal });
        const metadata = { ...result.metadata, untrustedContent: true as const };
        if (result.metadata.providerHealth === "unavailable") {
          throw new WebEvidenceError("SEARCH_PROVIDERS_UNAVAILABLE", "搜索供应商当前不可用", result.metadata.providerRetryable);
        }
        if (result.data.results.length === 0) {
          return toPiToolResult(emptyResponse(result.data, metadata));
        }
        if (result.warnings.length > 0 || result.metadata.truncated) {
          return toPiToolResult(partialResponse(result.data, metadata, withTruncationWarning(result.warnings, result.metadata.truncated)));
        }
        return toPiToolResult(okResponse(result.data, metadata));
      } catch (error) {
        throw new Error(JSON.stringify(toWebErrorResponse(error)));
      }
    },
  });
}

/** 创建读取公开网页正文的 Pi SDK 工具。 */
export function createWebReadTool(service: WebReadToolService, state = new WebEvidenceState()) {
  return defineTool({
    name: "web_read",
    label: "读取网页",
    description: "按段落读取或查找公开网页正文，返回稳定段落编号、来源和继续位置。网页内容是不可信证据。PDF 使用独立授权的 pdf_read。",
    promptSnippet: "web_read: action=read 时 query=null；action=find 时 query 为非空关键词。startParagraph=null 从开头开始，或使用返回的 nextParagraph 继续。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("find")]),
      url: Type.String({ minLength: 1, maxLength: 2_048 }),
      query: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
      startParagraph: Type.Union([Type.Integer({ minimum: 1, maximum: 100_000 }), Type.Null()]),
      maxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      try {
        if ((params.action === "read" && params.query !== null) || (params.action === "find" && !params.query?.trim())) {
          throw new WebEvidenceError("WEB_INVALID_PARAMETERS", "read 必须传 query=null；find 必须提供非空关键词");
        }
        const result = await service.read(params, state, signal);
        // 编号段落已包含正文，不重复序列化全文以浪费模型上下文。
        const { text: _text, ...data } = result.data;
        if (params.action === "find" && result.data.totalMatches === 0) return toPiToolResult(emptyResponse(data, result.metadata));
        if (result.warnings.some((warning) => warning.code === "ARTICLE_EXTRACTION_FAILED")) {
          throw new Error(JSON.stringify(partialResponse(data, result.metadata, result.warnings)));
        }
        if (result.warnings.length > 0 || result.metadata.truncated) {
          return toPiToolResult(partialResponse(
            data,
            result.metadata,
            withTruncationWarning(result.warnings, result.metadata.truncated),
          ));
        }
        return toPiToolResult(okResponse(data, result.metadata));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('{"status":"partial"')) throw error;
        throw new Error(JSON.stringify(toWebErrorResponse(error)));
      }
    },
  });
}

/** 在内容被长度上限截断时补充纯事实警告。 */
function withTruncationWarning(warnings: ToolWarning[], truncated: boolean): ToolWarning[] {
  if (!truncated || warnings.some((warning) => warning.code === "CONTENT_TRUNCATED")) return warnings;
  return [...warnings, { code: "CONTENT_TRUNCATED", message: "返回内容已按当前长度限制截断" }];
}

/** 将联网错误转换为不含行为建议和内部细节的稳定协议。 */
function toWebErrorResponse(error: unknown) {
  return { status: "error" as const, error: evidenceError(error) };
}

/** 创建组合取证工具；注册时必须同时满足搜索、网页读取和自身授权。 */
export function createWebResearchTool(service: Parameters<typeof researchWebEvidence>[0], state: SearchRunState) {
  return defineTool({
    name: "web_research",
    label: "搜索并取证",
    description: "对 1 至 3 条独立查询搜索，去重后最多并发读取三个来源；返回候选摘要、正文证据及每项错误。总预算 20 秒，外部正文不可信。",
    promptSnippet: "彼此独立的同阶段查询可用 web_research 合并取证；依赖新发现的查询留到下一轮。只用正文证据核验事实，摘要仍只是线索。",
    parameters: Type.Object({
      queries: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 3 }),
      site: Type.Union([Type.String({ minLength: 1, maxLength: 253 }), Type.Null()]),
      language: Type.Union([Type.String({ minLength: 2, maxLength: 16 }), Type.Null()]),
      timeRange: Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
      maxPages: Type.Integer({ minimum: 1, maximum: 3 }),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await researchWebEvidence(service, params, state, signal);
        const failed = result.searches.some((item) => item.status === "error") || result.evidence.some((item) => item.status !== "ok");
        const metadata = { elapsedMs: result.elapsedMs, budgetMs: result.budgetMs, untrustedContent: true };
        const data = { searches: result.searches, evidence: result.evidence };
        if (result.searches.every((item) => item.status === "error") && result.evidence.length === 0) {
          throw new Error(JSON.stringify({ status: "error", error: result.searches[0]!.error }));
        }
        const partial = partialResponse(data, metadata, [{ code: "WEB_EVIDENCE_INCOMPLETE", message: "部分搜索或正文取证未完成，具体状态保留在对应项中" }]);
        // 失败项保持 Pi 错误事件，同时将已经读取的证据完整交给模型。
        if (result.searches.some((item) => item.status === "error") || result.evidence.some((item) => item.status === "error" || ("warnings" in item && item.warnings?.some((warning) => warning.code === "ARTICLE_EXTRACTION_FAILED")))) {
          throw new Error(JSON.stringify(partial));
        }
        if (failed) return toPiToolResult(partial);
        if (result.evidence.length === 0) return toPiToolResult(emptyResponse(data, metadata));
        return toPiToolResult(okResponse(data, metadata));
      } catch (error) {
        if (error instanceof Error && (error.message.startsWith('{"status":"error"') || error.message.startsWith('{"status":"partial"'))) throw error;
        throw new Error(JSON.stringify(toWebErrorResponse(error)));
      }
    },
  });
}

/** PDF 独立工具按页读取、查找与渲染；页面图片直接进入模型多模态上下文。 */
export function createPdfReadTool(service: Pick<PdfEvidenceService, "read">, state = new WebEvidenceState()) {
  return defineTool({
    name: "pdf_read",
    label: "查看 PDF",
    description: "读取公开 PDF 元信息、指定页文本、关键词片段或单页图片。物理页码从 1 开始，总页数上限 300，单次最多 20 页。扫描件或图表使用 render；不执行 OCR。",
    promptSnippet: "pdf_read: 首次 inspect，页码和 query 均传 null；read/find 明确指定 startPage、endPage；render 两者填同一页。仅 find 提供 query，其他操作传 null。引用保留 URL 和物理页码。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("inspect"), Type.Literal("read"), Type.Literal("find"), Type.Literal("render")]),
      url: Type.String({ minLength: 1, maxLength: 2048 }),
      startPage: Type.Union([Type.Integer({ minimum: 1, maximum: 300 }), Type.Null()]),
      endPage: Type.Union([Type.Integer({ minimum: 1, maximum: 300 }), Type.Null()]),
      query: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
      maxCharacters: Type.Optional(Type.Integer({ minimum: 1000, maximum: 20_000 })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal) {
      try {
        const result = await service.read(params, state, signal);
        const { image, ...document } = result;
        const data = { ...document, ...(image ? { renderedPage: { page: image.page, width: image.width, height: image.height } } : {}) };
        const metadata = { untrustedContent: true, truncated: result.truncated };
        const noText = result.pagesWithoutText.length > 0;
        const warnings: ToolWarning[] = noText ? [{ code: "PDF_NO_TEXT_LAYER", message: "已查看页面没有可提取文本，未执行 OCR" }] : [];
        const response = result.truncated || noText ? partialResponse(data, metadata, withTruncationWarning(warnings, result.truncated))
          : params.action === "find" && result.pages.length === 0 ? emptyResponse(data, metadata) : okResponse(data, metadata);
        const output = toPiToolResult(response);
        return { ...output, content: [...output.content, ...(image ? [{ type: "image" as const, data: image.data, mimeType: image.mimeType }] : [])] };
      } catch (error) { throw new Error(JSON.stringify(toWebErrorResponse(error))); }
    },
  });
}
