import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const scheduledTaskSkill = `---
name: scheduled-tasks
description: 管理当前 Agent 的定时任务。
---

# 定时任务

使用 \`scheduled_tasks\` 管理当前 Agent 的任务。此工具已限定当前 Agent：不得尝试读取、修改或删除其他 Agent 的任务。

## 会话身份与范围

- 当前身份由每轮系统上下文提供，不需要读取环境变量，也不能从任务目标猜测自身 session_id。
- 每次调用显式传 \`scope: current_session\` 或 \`scope: agent\`。通常选择 current_session，仅操作绑定到当前会话执行的任务。
- 只有用户明确要求跨会话、当前 Agent 全部任务或每次新建会话执行时，才选择 agent；范围拒绝不能作为自动扩大范围的理由。
- 新会话执行的任务不属于任何固定目标会话；任务创建来源与执行目标不是同一概念。
- list 返回 scope、currentSessionId 和 tasks；任务中的 targetsCurrentSession 标明执行目标是否为当前会话。
- 所有字段都必须提交；无关或不修改的字段传 JSON null，不能填写猜测值。

## 操作原则

- 不确定任务 ID、需先了解已有配置，或用户询问任务状态时，先调用 \`action: list\`。
- 修改和删除必须使用 list 返回的 \`id\`；不要根据名称猜测 \`taskId\`。
- 创建前确认提示词、调度方式和目标会话；修改只传需要变更的字段，null 字段保持不变。
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

- 当前会话：\`{ type: "current_session" }\`，由服务端解析真实 ID，不要复制历史会话 ID。
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
