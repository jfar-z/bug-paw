import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { readFixture, searchFixture } from "./fixtures";

/** 为深度研究回归注册确定性搜索与页面读取工具。 */
export default function registerEvaluationTools(pi: ExtensionAPI): void {
  const caseId = process.env.DEEP_RESEARCH_EVAL_CASE ?? "";
  const allowedSkillPath = resolve(process.cwd(), "src", "server", "skills", "deep-research", "SKILL.md");

  pi.registerTool(
    defineTool({
      name: "read",
      label: "读取被测 Skill",
      description: "只读取本次评测使用的 deep-research Skill 正文，不允许访问其他工作区文件。",
      promptSnippet: "读取被测 deep-research Skill 正文；不能读取其他文件。",
      parameters: Type.Object(
        {
          path: Type.String({ minLength: 1, maxLength: 2_048 }),
          offset: Type.Optional(Type.Integer({ minimum: 1 })),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_000 })),
        },
        { additionalProperties: false },
      ),
      async execute(_toolCallId, params) {
        const requestedPath = resolve(process.cwd(), params.path);
        if (requestedPath !== allowedSkillPath) {
          throw new Error("评测 read 仅允许读取 deep-research Skill");
        }

        const content = await readFile(allowedSkillPath, "utf8");
        const lines = content.split("\n");
        const offset = params.offset ?? 1;
        const limit = params.limit ?? lines.length;
        const selected = lines.slice(offset - 1, offset - 1 + limit).join("\n");
        return {
          content: [{ type: "text", text: selected }],
          details: { path: allowedSkillPath, offset, lines: selected.split("\n").length },
        };
      },
    }),
  );

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
