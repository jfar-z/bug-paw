import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentPromptFile, AgentPromptStore } from "./agent-prompt-store";

const promptFileSchema = Type.Union([
  Type.Literal("role"), Type.Literal("behavior"), Type.Literal("rules"), Type.Literal("user"), Type.Literal("bootsharp"),
]);
const promptActionSchema = Type.Union([
  Type.Literal("read"), Type.Literal("replace"), Type.Literal("clear"),
]);

/** 创建只能操作当前 Agent 五个固定提示词文件的 SDK 工具。 */
export function createEditOwnPromptsTool(
  agentId: string,
  prompts: AgentPromptStore,
  onUpdated: () => Promise<void>,
) {
  return defineTool({
    name: "edit_own_prompts",
    label: "编辑自身提示词",
    description: "读取、替换或清空你自己的角色、行为风格、规则、用户和 BOOTSHARP 提示词文件。",
    promptSnippet: "修改自身长期设定前先用 edit_own_prompts 的 read 核对；只能编辑自己的五个提示词文件。",
    parameters: Type.Object({
      action: promptActionSchema,
      file: promptFileSchema,
      content: Type.Optional(Type.String({ description: "replace 操作要写入的完整提示词内容" })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params) {
      try {
        const file = params.file as AgentPromptFile;
        if (params.action === "read") return success({ file, content: await prompts.read(agentId, file) });
        if (params.action === "replace") {
          if (typeof params.content !== "string") return failure("replace 操作必须提供 content");
          await prompts.replace(agentId, file, params.content);
        } else await prompts.clear(agentId, file);
        const content = await prompts.read(agentId, file);
        await onUpdated();
        return success({ file, empty: content.length === 0, characters: content.length });
      } catch (error) {
        return failure(error instanceof Error ? error.message : "提示词编辑失败");
      }
    },
  });
}

/** 返回包含工具可读状态的成功结果。 */
function success(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
}

/** 返回可让 Agent 修正参数或重试的失败结果。 */
function failure(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: {} };
}
