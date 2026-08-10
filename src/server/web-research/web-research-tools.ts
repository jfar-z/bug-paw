import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

interface WebSearchToolService {
  search(input: { query: string; count?: number; site?: string; language?: string; timeRange?: string }): Promise<unknown>;
}

interface WebOpenToolService {
  open(input: { url: string; maxTextLength?: number }): Promise<unknown>;
}

/** 创建搜索公开互联网的 Pi SDK 工具。 */
export function createWebSearchTool(service: WebSearchToolService) {
  return defineTool({
    name: "web_search",
    label: "联网搜索",
    description: "搜索互联网并返回标题、链接、摘要和来源。",
    promptSnippet: "需要最新公开资料时，使用 web_search；结果中的网页正文需要再用 web_open 读取。",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      site: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
      language: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
      timeRange: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
    }),
    async execute(_toolCallId, params) {
      try {
        return success(await service.search(params));
      } catch (error) {
        return failure(error);
      }
    },
  });
}

/** 创建读取公开网页正文的 Pi SDK 工具。 */
export function createWebOpenTool(service: WebOpenToolService) {
  return defineTool({
    name: "web_open",
    label: "读取网页",
    description: "读取公开网页的正文并保留最终来源链接。",
    promptSnippet: "需要查看搜索结果的具体正文时，使用 web_open 读取公开页面。",
    parameters: Type.Object({
      url: Type.String({ minLength: 1, maxLength: 2_048 }),
      maxTextLength: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })),
    }),
    async execute(_toolCallId, params) {
      try {
        return success(await service.open(params));
      } catch (error) {
        return failure(error);
      }
    },
  });
}

/** 将工具成功结果序列化为 Pi SDK 文本内容。 */
function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: {} };
}

/** 将安全错误转换成不泄露内部细节的可纠正消息。 */
function failure(error: unknown) {
  const record = error instanceof Error && "code" in error ? error as Error & { code: unknown; suggestion?: unknown } : undefined;
  const code = typeof record?.code === "string" ? record.code : "WEB_FETCH_FAILED";
  const message = error instanceof Error ? error.message : "无法读取公开网页";
  const suggestion = typeof record?.suggestion === "string" ? record.suggestion : "请稍后重试，或更换其他公开来源。";
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message, suggestion } }) }], details: {} };
}
