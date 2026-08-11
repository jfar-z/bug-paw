# 联网检索集成与安全边界

## 背景与目标

BugPaw 需要让 Agent 能够检索互联网并读取公开网页，同时保持自托管、低资源占用和清晰的权限边界。

当前实现只提供两项只读能力：

```text
web_search：搜索互联网
web_read：读取公开网页的正文
```

当前不支持网页点击、表单输入、登录、上传、提交、截图或站点批量爬取。

## 当前实现

### 组件选择

```text
SearXNG                         提供搜索结果
@extractus/article-extractor    在 Node 服务内提取网页正文
```

SearXNG 通过其 JSON Search API 返回标题、链接和摘要。默认由同一份 Compose 启动内部 `bug-paw-search` 与 `bug-paw-cache` 服务；管理员也可以在能力扩展页改为其他受管实例。两个搜索相关容器均不映射宿主机端口。

部署前在根目录 `.env` 设置 `SEARXNG_SECRET` 为强随机值。该文件属于部署环境，不应提交到代码仓库，也不得在接口、日志或诊断中回显其值。

`@extractus/article-extractor` 直接运行在现有 Node 服务内，用于把静态网页提取成 Agent 易于消费的正文和元数据。该方案不引入 Python、Chromium 或额外容器，适合文档、博客、新闻、GitHub 等公开静态网页。

参考资料：

- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)
- [@extractus/article-extractor](https://www.npmjs.com/package/%40extractus/article-extractor)

### 与核心 SDK 的集成

联网工具属于 BugPaw 自身的系统能力，按项目约定通过 SDK `customTools` 注册，不作为核心扩展文件安装。

运行时只在“联网检索”已启用时注册 `web_search` 和 `web_read`。工具名称同时进入 Agent 的可配置工具目录；只有管理员在对应 Agent 的“工具权限”中显式勾选后，才会进入该 Agent 的运行时白名单。Runtime 创建时会同时计算有效联网能力快照；工具注册和系统提示词的联网路由政策共同使用该快照。

```text
Agent 工具权限
  ↓ 显式授权
SDK tools allowlist
  ↓
customTools: web_search / web_read
  ↓
SearXNG 与 Node 正文提取器
```

这意味着：

- 未启用联网检索时，工具不会注册或执行；
- 已启用但未授权的 Agent 不可调用工具；
- 新增工具不会自动扩大已有 Agent 的权限；
- 新建 Agent 默认预授权两个联网工具，但全局能力关闭时工具不注册；
- 管理员可以为研究型 Agent 授权，而让日常 Agent 保持离线。

### 配置边界

在配置中心的“能力扩展”模块提供“联网搜索”子页，至少包含：

- 启用开关；
- SearXNG 基础地址；
- 每次搜索的最大结果数；
- 单页最大正文长度；
- 请求超时。
- 最大重定向数、最大响应体、HTTPS 策略、域名允许名单与允许内容类型。

配置只保存在服务端。若未来接入需要认证的搜索服务，其凭证不得返回前端、写入日志或出现在诊断响应中。

### 工具输入与输出

`web_search` 接收查询词以及可选的站点限定、时间范围、语言和结果数量。它过滤非 HTTP(S) 地址、规范化并去重 URL、合并搜索引擎来源，返回 `rank`、`title`、`url`、`hostname`、`snippet`、`sourceEngines` 与可验证的 `publishedAt`；无法确认发布时间时为 `null`。

`web_read` 接收 URL 和可选正文字符数限制，返回请求地址、最终地址、标题、主机名、正文、发布时间、抓取时间、内容类型与正文提取方式。HTML 正文提取失败时降级为清理后的文本，并以 `partial` 和 `ARTICLE_EXTRACTION_FALLBACK` 记录事实；超出长度限制时以 `partial` 和截断元数据记录事实。

两个工具统一返回 `ok`、`empty`、`partial` 或 `error`。成功类响应包含 `data`、`metadata` 和事实性 `warnings`；错误只包含稳定的 `code`、安全消息与 `retryable`。`retryable` 只描述错误是否具备重试条件。工具响应不包含 `nextAction`、行为建议或答案充分性判断。联网结果的 Metadata 标记 `untrustedContent: true`，且始终保留来源 URL，供 Agent 引用和前端展示。

系统政策把 `web_search` 的标题与摘要定义为发现线索，而不是已核验事实。当 `web_read` 同时可用时，Agent 在回答事实问题前必须主动读取至少一个相关页面，不需要等待用户额外要求“查看页面”；发布、可用性、版本、价格、政策、法律、规格和下载优先读取官方或一手来源。页面无法读取时必须说明结论未核验。只有用户明确要求候选链接或搜索结果列表时，才可以不逐页读取直接返回搜索结果。

BugPaw 不自动安装 `web-research` Skill。上述最低路由与核验规则由有效能力快照动态注入系统提示词，用户可以另行安装调研 Skill 组织多轮查询或来源比较。工具结果只提供数据和状态，不能扩大用户指定的来源范围。

### 安全与资源限制

联网读取是只读能力，但仍须执行以下限制：

- 仅接受 `http` 和 `https` URL；
- 拒绝回环、私网、链路本地、云元数据等地址；
- 每次重定向后再次校验目标地址；
- 限制请求超时、重定向次数、响应体大小和正文长度；
- 限制每次工具调用的搜索结果数；
- 不携带 BugPaw 登录 Cookie、用户上传的凭证或内部认证 Header；
- 将网页正文视为不可信内容，不能把其中的指令当作系统或工具指令执行。

### 安全验收标准

1. 管理员配置可用的 SearXNG 地址并启用联网检索后，系统能完成公开网页搜索。
2. 已授权 Agent 能读取普通公开网页并获得去除导航、广告等噪声后的正文。
3. 未授权 Agent 在运行时无法调用上述工具。
4. 内网 URL、非法协议、超时页面、过大页面和重定向到受限地址的请求均被安全拒绝。
5. 工具结果包含可追溯的原始 URL。

## 可选演进方向：Playwright

当当前实现无法处理 JavaScript 渲染、懒加载或复杂公开页面时，可以引入 Playwright 无头浏览器作为网页渲染能力。

该扩展仍以“读取公开内容”为目标：Playwright 负责在隔离环境中加载页面、等待必要渲染并提取内容；不得将其扩展为代替用户执行登录、填写或提交操作的通用浏览器自动化能力。

实施前必须重新评估以下事项：

- 浏览器进程的内存、并发和超时预算；
- 容器隔离、网络访问范围和下载限制；
- 动态网页内容的安全过滤；
- 与现有 `web_read` 结果格式的一致性；
- 失败时的可观测性与用户可理解的诊断信息。

现有工具名称、授权模型和来源数据格式应保持稳定，使 Playwright 能力可以作为底层实现演进，而不需要改变 Agent 的使用方式。

参考资料：[Playwright](https://github.com/microsoft/playwright)
