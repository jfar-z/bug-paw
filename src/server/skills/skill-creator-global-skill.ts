import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const skillCreatorGlobalSkill = `---
name: skill-creator
description: 创建、审阅和安装适用于 BugPaw 的 Pi Skill。用户要求创建新 Skill、从外部渠道获取 Skill、审阅 Skill 或选择 Skill 安装作用域时使用。
---

# Skill 创建与安装

创建或引入 Skill 时，使用 Pi/BugPaw 的资源目录和格式。不要使用 Codex 专属目录、元数据或工具。

## 创建新 Skill

- 创建前必须询问用户：安装到全局目录，还是当前 Agent 目录？未得到明确选择前，不得写入正式技能目录。
- 询问时必须同时展示以下两个目标：
  - 全局：\`/data/pi/skills/<技能名>\`，所有 Agent 可发现。
  - 当前 Agent：\`<当前 Agent 工作目录>/.pi/skills/<技能名>\`，仅当前 Agent 可发现。
- 不得使用默认 Agent 或其他 Agent 的静态路径示例；必须基于当前 Agent 的实际工作目录构造当前 Agent 路径。
- 新 Skill 的最小结构是 \`<技能目录>/SKILL.md\`。文件使用 UTF-8 编码，并以 YAML 前置元数据声明 \`name\` 和 \`description\`。
- 创建前检查内容不含密钥、账号、Token、身份信息或生产数据。

## 从外部渠道获取 Skill

- 可以先下载到临时目录，不得在下载阶段直接写入全局或当前 Agent 的正式技能目录。
- 在临时目录审阅来源、文件清单、指令内容、依赖、可执行脚本和 Pi 兼容性。
- 发现敏感信息、危险脚本、无法确认的来源或不兼容依赖时，停止安装并向用户报告风险。
- 审阅通过后，必须询问用户选择全局或当前 Agent 安装目录；未得到明确选择前，不得复制或移动到正式技能目录。
- 安装完成后，说明实际写入的目录和可发现范围。

## 内容与验证

- Skill 只保留完成任务所需的 \`SKILL.md\`、脚本、参考资料和资产；不要添加无关的 README、安装说明或过程文档。
- \`name\` 使用小写字母、数字和连字符；\`description\` 清晰说明能力和触发场景。
- 如果包含脚本，先检查依赖是否在当前运行环境可用，并在安装前验证脚本。
- 不要添加 Codex 专属元数据、目录或环境变量约定。
`;

/**
 * 安装供所有 Pi 会话发现的技能创建助手 Skill。
 *
 * @param agentDir Pi 全局数据目录
 */
export async function ensureSkillCreatorGlobalSkill(agentDir: string): Promise<void> {
  const directory = join(agentDir, "skills", "skill-creator");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "SKILL.md"), skillCreatorGlobalSkill, { encoding: "utf8", mode: 0o600 });
}
