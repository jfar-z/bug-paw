import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const scheduledTaskSkill = `---
name: scheduled-tasks
description: 管理当前 Agent 的定时任务。
---

# 定时任务

使用 \`scheduled_tasks\` 管理当前 Agent 的任务。此工具已限定当前 Agent：不得尝试读取、修改或删除其他 Agent 的任务。

## 操作原则

- 不确定任务 ID、需先了解已有配置，或用户询问任务状态时，先调用 \`action: list\`。
- 修改和删除必须使用 list 返回的 \`id\`；不要根据名称猜测 \`taskId\`。
- 创建前确认提示词、调度方式和目标会话；修改只传需要变更的字段，未传字段保持不变。
- 工具返回的 \`nextRunAt\`、\`lastRunAt\` 是 ISO 时间；向用户说明时转换为易读时间并保留时区。

## 操作

- 查询：\`action: list\`。
- 创建：\`action: create\`，必须提供 \`name\`、\`prompt\`、\`enabled\`、\`schedule\` 和 \`target\`。
- 修改：\`action: update\` 与 \`taskId\`；仅传需要更新的 \`name\`、\`prompt\`、\`enabled\`、\`schedule\` 或 \`target\`。
- 删除：\`action: delete\` 与 \`taskId\`。删除不可恢复；执行记录会一并删除。

## 调度格式

- 间隔：\`{ type: "interval", value: 正整数, unit: "minute" | "hour" }\`。
- Cron：\`{ type: "cron", expression, timezone }\`。使用五段 Cron（分 时 日 月 周），不带秒字段；\`timezone\` 使用 IANA 时区，例如 \`Asia/Shanghai\`。
- 单次：\`{ type: "once", runAt }\`。\`runAt\` 使用含时区的 ISO 8601 时间；执行一次后任务会自动暂停。

## 目标会话与执行行为

- 每次新建会话：\`{ type: "new_session", archiveAfterCompletion }\`。每次触发创建独立会话；仅在执行完成后，\`archiveAfterCompletion: true\` 才会自动归档。
- 现有会话：\`{ type: "existing_session", sessionId }\`。选择现有会话 ID；若该会话正在执行，触发会跳过并记录原因，不重试。
- 触发时系统会向目标会话发送“这是定时任务发出的消息”与配置的提示词。执行记录请在定时任务页面查看。
`;

/** 安装供所有 Pi 会话发现的定时任务说明 Skill。 */
export async function ensureScheduledTaskSkill(agentDir: string): Promise<void> {
  const directory = join(agentDir, "skills", "scheduled-tasks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "SKILL.md"), scheduledTaskSkill, { encoding: "utf8", mode: 0o600 });
}
