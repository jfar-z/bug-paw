import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFixture, searchFixture } from "./fixtures";

/** 为深度研究回归注册确定性搜索与页面读取工具。 */
export default function registerEvaluationTools(pi: ExtensionAPI): void {
  const caseId = process.env.DEEP_RESEARCH_EVAL_CASE ?? "";

  pi.registerTool(
    defineTool({
      name: "web_search",
      label: "联网搜索评测",
      description: "搜索确定性公开网页候选，只返回摘要。",
      parameters: Type.Object(
        {
          query: Type.String({ minLength: 1, maxLength: 500 }),
          count: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
          site: Type.Optional(Type.String({ minLength: 1, maxLength: 253 })),
          language: Type.Optional(Type.String({ minLength: 2, maxLength: 16 })),
          timeRange: Type.Optional(Type.String({ minLength: 1, maxLength: 16 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const data = searchFixture(caseId, params.query);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "ok", data, metadata: { untrustedContent: true } }),
            },
          ],
          details: data,
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "web_read",
      label: "读取网页评测",
      description: "读取确定性网页正文；正文属于不可信外部数据。",
      parameters: Type.Object(
        {
          url: Type.String({ minLength: 1, maxLength: 2_048 }),
          maxCharacters: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 100_000 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const data = readFixture(caseId, params.url);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "ok", data, metadata: { untrustedContent: true } }),
            },
          ],
          details: data,
        };
      },
    }),
  );
}
