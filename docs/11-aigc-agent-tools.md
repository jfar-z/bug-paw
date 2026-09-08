# AIGC 接口发布为 Agent 工具

## 启用

1. 在 AIGC 工作台配置并验证 OpenAI、Grok 或 ComfyUI 接口。
2. 在接口列表编辑区或接口详情中勾选“发布为 Agent 工具”并保存，同时保持接口和渠道启用。
3. 在 Agent 的工具权限中分别授予所需的 AIGC 工具。新旧 Agent 均不自动获得这些权限。

发布开关在每次调用时读取，撤销后不能发现、提交或读取该接口的任务。为保留止损能力，仍允许具有取消权限的任务所有者取消自己的既有任务。通用文件、命令权限可能绕过业务工具边界，不能把工具白名单当作操作系统沙箱。

## 工具协议

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `aigc_list_interfaces` | 分页查询接口；指定 `interfaceId` 获取参数定义 | 单独授权 |
| `aigc_run` | 校验参数、异步提交并返回 `taskId` | 高风险，可能计费 |
| `aigc_run_and_wait` | 提交并等待终态，成功后直接交付文件 | 高风险，单独授权 |
| `aigc_get_task` | 查询所属任务，完成时交付工作区文件 | 单独授权 |
| `aigc_cancel_task` | 取消所属任务，返回上游确认状态 | 高风险，单独授权 |

接口列表每页 20 项，使用 `offset` / `nextOffset`；详情返回字段类型、必填性、默认值、枚举和数值范围。列表不返回渠道 URL、凭据或原始工作流。工具响应上限 64 KiB。

The interface editor stores an Agent-specific usage description. With `interfaceId`, the detail response includes `instructions`, `fields`, and `outputs`; each output defines `id`, `name`, `mediaType`, `description`, and `multiple`.

`aigc_run` 示例：

```json
{
  "interfaceId": "<接口 ID>",
  "requestKey": "cover-001",
  "parameters": [
    { "name": "prompt", "text": "一幅城市天际线插画" },
    { "name": "steps", "number": 20 }
  ]
}
```

每个参数项只提供 `text`、`number`、`boolean`、`path` 中的一种。先读取接口定义，不猜测字段。可选字段缺失时使用已配置默认值；必填字段缺失且无默认值时拒绝提交。枚举保留真实标量类型，数字枚举不能强制转为字符串。

所有接口的本地媒体均通过 `path` 指定当前 Agent 工作区相对路径，不接受任意资产 ID、宿主机路径、其他 Agent 文件或 ComfyUI input 文件名。服务端复用工作区路径、符号链接、大小和媒体类型校验，并按协议处理：OpenAI 保存到私有输入区后以 multipart 上传，ComfyUI 保存到私有输入区后上传到 ComfyUI input，Grok 自动复制到公开目录并提交稳定 URL。

Grok 本地媒体要求配置 `BUG_PAW_PUBLIC_ORIGIN`。该值必须是无需认证即可被上游访问的 HTTP(S) Origin，不得包含路径、凭据、查询参数或片段。未配置时，只有进程能读取到明确的 `BUG_PAW_BIND_ADDRESS` 才会回退到监听地址；通配地址不会被当作可访问地址。自动公开发生在计费任务创建前，创建失败会删除本次公开副本；任务创建成功后文件保留在公开目录，可由用户统一管理。

## 任务归属与幂等

### 阻塞工具

`aigc_run_and_wait` 使用与 `aigc_run` 相同的参数和幂等作用域，默认不授权。只授予它自身的权限即可执行提交、内部状态查询和文件交付；发现接口仍使用单独授权的 `aigc_list_interfaces`。

工具通过 Pi 的 `onUpdate` 回调报告任务 ID、排队和执行进度，每 5 秒读取一次最新状态，不占用外部 `aigc_get_task` 的查询限频窗口。内部读取仍检查任务归属、当前工具权限及接口发布状态。

返回值包含实际任务 `status`、`taskId`、`files` 和等待状态 `waitStatus`：

- `completed`：任务进入成功、失败或取消终态；不等于生成成功，必须检查 `status`。
- `timed_out`：达到 30 分钟等待上限，返回最近读取的任务状态，不取消或重新提交任务。
- `interrupted`：任务提交后用户中止聊天，只停止等待，后台任务仍继续；SDK 中止时可能不会展示最终工具结果，先前进度事件包含任务 ID。

需要继续等待时，在原会话使用同一个 `requestKey` 和相同参数再次调用，不生成重复任务。取消生成仍需 `aigc_cancel_task`。底层 Agent 任务现有的 30 分钟执行上限保持不变，与等待期限独立计算；等待工具不会延长任务执行上限。

### 归属规则

- Runtime 注入 `agentId` 和 `sessionId`，模型不能设置或覆盖。
- 新 Agent 任务在既有任务记录中保存 `agentOrigin`；历史手动任务没有该字段，只能在工作台管理。
- 查询、取消和产物交付按 Agent 隔离，允许同一 Agent 跨会话查询自己的任务。
- `requestKey` 以 Agent 和来源会话为作用域。同一次生成的重试必须使用同一个键：参数相同返回已有任务，参数不同返回冲突；不会自动重试失败、取消或中断的任务。
- 新键表示明确创建新任务。工具不会把不同键的两次生成意图合并，也不能保证上游网络服务具备事务性。
- 异常重启时，进行中的 Agent 任务标记为中断失败，不自动恢复提交。需人工核对上游再决定重试。
- 任务历史串行原子写入，避免并发更新丢失。工作台管理员保留管理全部任务的能力。

## 限额与交付

- 每个 Agent 最多 2 个活动任务，整个服务最多 8 个 Agent 活动任务；手动工作台任务不计入该限额。
- 每个 Agent 每小时最多提交 20 个任务，同键重试不增加计数。
- 查询硬限制间隔 2 秒，正常返回建议间隔 `pollAfterMs=5000`。
- 参数最多 100 项、128 KiB；单个工作区输入文件最多 100 MiB，单任务媒体输入合计最多 200 MiB。
- Agent 任务本地执行上限 30 分钟。超时不表示上游已经停止。
- 一次交付最多 20 个产物、合计 200 MiB；超过时在 AIGC 工作台查看，不把大文件塞入模型上下文。
- 产物先保存在 AIGC 资产区，查询成功任务时复制到所属 Agent 的 `attachments/`，记录已交付路径避免正常重复查询产生副本。
- Delivered `files` include `outputId` and `outputName`. ComfyUI mappings retain distinct identifiers, and multiple files from one mapping share that mapping identity.
- 对话使用已有 `pi_agent_files` 协议交付相对路径。不会返回内部绝对路径或未经授权的公共链接。

## 取消与后台行为

`status=cancelled` 表示 BugPaw 本地任务停止；只有 `upstreamCancellation=confirmed` 表示上游排队任务已确认移除。

ComfyUI 只尝试删除精确 `prompt_id` 对应的排队项，并复核队列和历史。已在运行、网络故障或状态不明时返回 `unknown`，绝不调用全局 `/interrupt`。OpenAI/Grok 请求中止通常无法保证上游取消，返回 `unknown`，可能继续产生算力消耗或费用。

后台任务不随聊天工具调用返回而终止。当前没有任务完成主动推送到聊天的功能，Agent 应返回任务 ID 和实际状态，不承诺自动通知，也不能反复提交任务来查询进度。

## 验证

回归覆盖工具根 Schema、默认权限、发布撤销、跨 Agent/历史任务隔离、参数校验、幂等与并发、查询限频、工作区媒体边界、产物交付、上游取消语义、迟到成功响应以及重启中断。按项目规定的 Node Docker 环境执行 `npm run verify`。
