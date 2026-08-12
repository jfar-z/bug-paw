# 配置中心运维说明

## 范围与事实来源

配置中心不修改 pi 上游源码。模型、凭证、运行设置和资源路径继续以 Pi 原生文件为事实来源；Web 自有数据只保存 Agent Profile、Session 元数据、事务清单和脱敏历史。

| 数据 | 路径 | 所有者 |
| --- | --- | --- |
| 全局模型 | `/data/pi/models.json` | Pi 原生配置 |
| Provider 凭证 | `/data/pi/auth.json` | Pi 原生配置，只写不回显 |
| 全局设置 | `/data/pi/settings.json` | Pi 原生配置 |
| Agent 覆盖设置 | `<agent-cwd>/.pi/settings.json` | Pi 项目配置 |
| Agent Profile | `/data/app/agents/<agentId>/profile.json` | Web 自有配置 |
| 配置历史 | `/data/app/config-history` | Web 脱敏审计与非敏感设置快照 |
| 配置事务 | `/data/app/config-transactions` | 中断恢复临时数据 |
| 联网搜索配置 | `/data/app/web-research.json` | Web 能力扩展配置 |
| 联网搜索凭证 | `/data/app/web-research-auth.json` | 搜索实例 API Key，仅服务端读取 |

配置 JSON 使用 revision 乐观锁和原子替换。页面读到的 revision 已过期时，服务返回 `409 VERSION_CONFLICT`；界面只允许重新加载，或把本地字段在最新 revision 上重新应用并再次校验，不支持盲目覆盖。

## Agent 与运行时

- `default` Agent 固定使用 `/data/workspace`，兼容已有 Session。
- 新 Agent 使用 `/data/workspace/agents/<UUID>`，ID 和 cwd 由服务端生成且不可编辑。
- Profile 包含名称、描述、初始字符或本地图片头像、角色与职责、行事作风、规则、用户设定、默认模型、思考等级和工具权限。
- 图片头像只接受 PNG、JPEG、WebP 魔数校验后的文件，最大 2 MiB。
- Agent 归档后不能创建新 Session；永久删除前会展示 Session 数和工作目录大小，工作目录删除进入可恢复垃圾目录流程。
- 多 Agent Runtime 共享模型目录，但工作目录、Session 目录和稳定系统指令相互隔离。
- 所有 Agent Runtime 都内置 cwd 相对路径文件交付协议；Agent 用 `<pi_agent_files version="1">` 结构块发送工作目录文件，Web 会展示文件卡片。

## 模型、凭证与 Pi 设置

Provider 和模型候选会先交给当前 Pi `ModelRuntime` Schema 校验，通过后才写入正式文件。Provider 删除时会检查 Agent 默认模型引用。

API Key 只写入 `auth.json`；列表接口仅返回 Provider ID、凭证类型和“已配置”状态。替换与删除均要求当前凭证 revision。诊断、日志、历史和导出不得包含 Key、Token、认证 Header 或 URL 内嵌凭证。

Pi 设置支持全局和 Agent 作用域。Agent 页面同时展示自有值、继承值和最终有效值；恢复继承会删除项目文件内对应点路径。`httpProxy` 仅允许全局修改。数值范围、未知字段和 Pi 原生读取结果都会在写入边界校验。

## Skills、扩展与包

资源目录直接来自 Pi `DefaultResourceLoader`，覆盖 Skills、Prompts、Extensions 和 Themes，并展示来源、作用域、启停、加载诊断和扩展注册工具。启停使用 Pi 原生 include/exclude patterns，不另建 Web 状态副本。

安装与卸载使用 Pi `DefaultPackageManager`，必须确认来源；长任务通过 SSE 输出脱敏日志。扩展和第三方 Skill 能以容器授予的最大权限运行，安装前必须审阅来源。全局包仍被任何 Agent 项目设置引用时，卸载返回 `409 PACKAGE_IN_USE`。

系统预装 Pi 兼容的 `skill-creator`，只提供创建、临时审阅和安装决策流程，不自动下载或安装外部 Skill。创建或从外部渠道获取的 Skill 在写入正式位置前，Agent 必须向用户确认安装到全局目录还是当前 Agent 目录。

BugPaw 不自动安装 `knowledge-base` 或 `web-research` Skill。检索的最低路由与来源核验边界由 Runtime 根据有效工具动态注入；用户仍可通过 Pi 资源机制安装和组合自己的调研 Skill，补充查询拆分、研究方法或领域工作流。

## 能力扩展与联网搜索

配置中心按“工作区 → 能力扩展 → 运行环境”组织。能力扩展保存独立于 Pi SDK 的增强能力与安全策略；联网搜索、TTS 与知识能力均在此模块配置。

联网搜索页面分为“服务状态”“已配置渠道”和“全局检索策略”。服务状态展示能力总开关、已启用渠道数与阻断问题；渠道列表只展示已有配置和实际故障切换顺序；全局策略默认折叠，其限制同时应用于所有搜索渠道及页面读取。“保存全局设置”只写全局策略，不会修改、覆盖或重排渠道。

联网搜索可以按管理员配置的顺序管理多个 SearXNG、博查 Web Search 与 Tavily Search 实例。搜索或全能力 Compose 组合中的 `bug-paw-search` 与 `bug-paw-cache` 会自动注册为“内置 SearXNG”，页面不要求填写容器名称、内部端口或地址；核心组合不会展示虚假的受管实例。部署前须在根目录 `.env` 设置强随机的 `SEARXNG_SECRET`；该文件为本机部署配置，不应提交。搜索服务不暴露宿主机端口。

新增和编辑渠道使用独立弹窗，实例配置与可选凭证在一个事务中保存；任一 revision 冲突或写入失败都不会留下半份配置。博查与 Tavily 的 API Key 使用独立 revision 保存在 `/data/app/web-research-auth.json`。配置列表只返回“已配置”状态；点击小眼睛时才按需读取明文，隐藏或关闭弹窗后清除浏览器内的值。全局能力启用时，启用中的直连实例必须已有 Key；移除 Key 会在同一渠道事务中同时停用实例。

Provider 数组顺序就是实际故障切换顺序，列表上移或下移后会立即保存，不依赖全局设置按钮。运行时只在实例返回 `unavailable` 时尝试下一个；健康空结果与带结果的降级响应都会停止路由。同一 Run 会跳过已失败实例，所有候选不可用后只阻止该 Run 的后续 `web_search`，不会终止 Agent 或影响其他工具；明确的 `Retry-After` 在后续 Run 中仍会被遵守。厂商原始错误、内部尝试过程、生成答案和 `nextAction` 均不进入 Agent 工具结果。

`bug-paw-embedding` 在同一内部网络提供默认中文语义检索模型，也不暴露宿主机端口。语义检索默认启用，资料上传时自动完成全文和向量索引；仅在更换模型、重新启用或修复索引时手动重建。

联网工具 `web_search` 与 `web_read` 仅在全局开关启用且对应 Agent 已授权时注入 Runtime。知识库工具 `knowledge_search`、`knowledge_read` 与 `knowledge_manage` 则按对应 Agent 的工具权限注册。系统在 Runtime 创建时生成一次有效能力快照，并用同一快照决定工具注册和系统提示词中的检索路由政策，避免提示词宣称了实际不可用的能力。新建 Agent 默认预授权检索工具，存量权限中的旧工具名会在数据库迁移时更新为新名称，不会借迁移扩大原有授权范围。

网页读取只允许公开 HTTP(S) 目标，并始终阻止回环、私网、链路本地、云元数据和危险重定向；这些底线不能关闭。管理员可进一步收紧 HTTPS、域名允许名单、内容类型、超时、重定向、响应体和正文长度。联网与知识库工具统一返回 `ok`、`empty`、`partial` 或 `error` 状态；响应只描述数据、降级、截断和错误事实，不携带 `nextAction` 或其他行为建议。

`web_search` 的摘要只用于发现候选来源；Agent 同时具备 `web_read` 时，事实回答默认至少读取一个相关页面，只有用户明确要求候选链接或搜索结果列表时可以直接列出搜索结果。工具输出不能扩大用户指定的来源或检索范围。

## 诊断、导入导出与历史

系统诊断执行只读检查：

- `models.json` 解析与 Pi Schema；
- Provider 凭证缺失；
- Agent cwd 和 Session 目录可写性；
- `/data` 对应容器挂载；
- 全局及 Agent 资源加载错误；
- Web、Node.js 和 Pi 版本。

安全导出排除 `auth.json` 和应用管理员密码；敏感 Header 与带认证信息的 URL 使用占位符。把安全包导回同一实例时，占位符会保留本机当前敏感值，不会以 `[REDACTED]` 覆盖正式配置。

导入支持安全配置包和标准 Pi `models.json`。预览阶段返回 `added`、`changed`、`conflicts`、`invalid`，不写正式文件；含冲突或无效项的预览无法应用。应用阶段再次执行 Pi 校验和 revision 检查，并通过多文件事务提交。

设置变更历史只公开时间、管理员、作用域和固定摘要。仅不含敏感字段的设置旧值生成可恢复快照；恢复时必须提交当前 revision，并再次通过现行 Pi Schema。

## Web 安全与 PWA

- 浏览器修改请求必须提供与当前 Host 匹配的 `Origin` 或 `Referer`；跨站请求和缺失来源信息的浏览器请求返回 `403 ORIGIN_REJECTED`。
- 非浏览器客户端在没有 `Sec-Fetch-*` 浏览器标识时可继续调用，但仍需通过相应认证。
- 配置、Provider、资源、诊断、历史、导入、凭证状态和任务 SSE 使用 `Cache-Control: no-store`。
- Service Worker 只缓存应用 shell 和静态资源；`/api/`、`/healthz` 与 `text/event-stream` 始终 network-only。
- 离线时显示连接提示，配置页写操作禁用；恢复在线后由浏览器事件自动解除。
- 局域网非 localhost 地址需要受信任 HTTPS 才能可靠安装 PWA。

## 备份、迁移与回滚

升级前停止写操作并备份完整 `pi-agent-data`。迁移会先检查 legacy 文件 revision，并通过事务写入 Pi 原生文件和默认 Agent Profile；重复运行不会改变 revision。发生外部并发修改时进入可审阅兼容状态，不覆盖用户文件。

推荐演练方式是把正式数据只读挂载到一次性容器，在容器内部复制到临时 `/data` 后运行迁移测试。不要直接在正式目录上执行测试迁移。

回滚步骤：

1. 停止当前容器；
2. 保留故障现场并复制完整 `pi-agent-data`；
3. 恢复升级前备份；
4. 使用原镜像重建容器；
5. 验证 `/healthz`、登录、现有 Session、模型列表和挂载路径。

不要只恢复单个 `auth.json`、`models.json` 或 Agent Profile；这些文件的 revision 和引用关系需要保持一致。

## 发布核验

```bash
docker compose ps
docker inspect --format '{{.State.Health.Status}}' bug-paw-web
curl -fsS http://127.0.0.1:7080/healthz
docker compose ps bug-paw-search bug-paw-cache bug-paw-embedding
docker inspect bug-paw-web --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

预期 `bug-paw-web` 为 `healthy`，搜索、缓存和 Embedding 服务为运行中，7080 端口可访问，且宿主机 `pi-agent-data` 挂载到容器 `/data`。
