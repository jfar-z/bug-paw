# 联网检索集成与安全边界

## 背景与目标

BugPaw 需要让 Agent 能够检索互联网并读取公开网页，同时保持自托管、低资源占用和清晰的权限边界。

当前实现向 Agent 提供以下独立授权的只读取证能力：

```text
web_search：搜索互联网
web_read：按段落读取或查找公开网页正文
web_research：合并独立查询搜索与有限正文取证
pdf_read：按页读取、查找和渲染公开 PDF
```

这些联网取证工具不执行网页交互、登录、提交或站点批量爬取。浏览器交互由独立浏览器工具及权限控制。PDF 页面渲染只针对已下载的文档，不启动浏览器。

## 当前实现

### 组件选择

```text
SearXNG / 博查 / Tavily         提供规范化搜索结果
SearchProviderRouter            按管理员顺序执行故障切换
@extractus/article-extractor    在 Node 服务内提取网页正文
```

SearXNG、博查 Web Search 与 Tavily Search Adapter 都只映射标题、链接、摘要、来源与可验证时间，并输出供应商无关的 `healthy`、`degraded` 或 `unavailable` 健康状态，以及稳定的 `rate_limited`、`authentication`、`timeout`、`captcha`、`upstream_error` 失败分类。博查不调用 AI Search；Tavily 固定关闭 Answer、原始正文和自动参数。厂商生成答案、追问建议、`nextAction` 与原始错误正文不会进入统一协议。

默认搜索 Compose 启动内部 `bug-paw-search` 与 `bug-paw-cache`。Web 服务通过部署能力注册表解析受管地址，配置文件和页面只保存 `connectionMode=managed`，不回显或要求管理员填写容器名与端口。两个搜索相关容器均不映射宿主机端口。核心部署仍可配置自定义 SearXNG 或直连搜索厂商。

业务服务只依赖统一搜索供应商接口。Router 按配置数组顺序串行尝试启用实例，只在 `unavailable` 时切换；`healthy + []` 是有效空结果，`degraded + results` 是有效部分结果，两者都不会切换厂商或改写查询。一次逻辑搜索不会重复同一实例，同一 Run 会继续跳过已失败实例；厂商 `Retry-After` 尚未到期时，新 Run 也会跳过该实例。

部署前在根目录 `.env` 设置 `SEARXNG_SECRET` 为强随机值。该文件属于部署环境，不应提交到代码仓库，也不得在接口、日志或诊断中回显其值。

`@extractus/article-extractor` 直接运行在现有 Node 服务内，用于把静态网页提取成 Agent 易于消费的正文和元数据。该方案不引入 Python、Chromium 或额外容器，适合文档、博客、新闻、GitHub 等公开静态网页。

参考资料：

- [SearXNG Search API](https://docs.searxng.org/dev/search_api.html)
- [@extractus/article-extractor](https://www.npmjs.com/package/%40extractus/article-extractor)

### 与核心 SDK 的集成

联网工具属于 BugPaw 自身的系统能力，按项目约定通过 SDK `customTools` 注册，不作为核心扩展文件安装。

运行时只在“联网检索”已启用且对应 Agent 已获授权时注册上述工具。工具名称同时进入 Agent 的可配置工具目录；只有管理员在对应 Agent 的“工具权限”中显式勾选后，才会进入该 Agent 的运行时白名单。Runtime 创建时会同时计算有效联网能力快照；工具注册和系统提示词的联网路由政策共同使用该快照。

```text
Agent 工具权限
  ↓ 显式授权
SDK tools allowlist
  ↓
customTools: web_search / web_read / web_research / pdf_read
  ↓
SearXNG 与 Node 正文提取器
```

这意味着：

- 未启用联网检索时，工具不会注册或执行；
- 已启用但未授权的 Agent 不可调用工具；
- 新增工具不会自动扩大已有 Agent 的权限；
- 新建 Agent 默认预授权四个只读取证工具，但全局能力关闭时工具不注册；
- 存量 Agent 不自动获得 `web_research` 或 `pdf_read`；在 Agent 工具权限中手动勾选。`web_research` 还必须同时拥有 `web_search` 与 `web_read`，不能通过组合工具绕过读取权限；
- 管理员可以为研究型 Agent 授权，而让日常 Agent 保持离线。

### 配置边界

在配置中心的“能力扩展”模块提供“联网搜索”子页，包含：

- 启用开关；
- 有序的 SearXNG、博查与 Tavily 实例卡片；
- 实例启停、上移/下移、单实例测试与删除；
- 自定义 SearXNG 地址、实例级出口和超时；
- 直连实例 API Key 的按需查看、替换与删除；
- 每次搜索的最大结果数；
- 单页最大正文长度；
- 页面读取出口和超时；
- 最大重定向数、最大响应体、HTTPS 策略、域名允许名单与允许内容类型。

非敏感路由配置保存在 `/data/app/web-research.json`，API Key 独立保存在 `/data/app/web-research-auth.json`。普通配置、日志、历史、诊断和安全导出均不包含明文；凭证只在管理员主动点击小眼睛时由独立 `no-store` 接口按需返回。

### 工具输入与输出

`web_search` 接收查询词以及可选的站点限定、时间范围、语言和结果数量。它过滤非 HTTP(S) 地址、规范化并去重 URL、合并搜索引擎来源，返回 `rank`、`title`、`url`、`hostname`、`snippet`、`sourceEngines` 与可验证的 `publishedAt`；无法确认发布时间时为 `null`。

`web_read` 接收必填 `action=read|find`、URL、`query`（read 传 null，find 传关键词）、`startParagraph`（null 或返回的段落编号），以及可选正文字符数限制。默认返回 6000 字符，仍受管理员最大长度约束。正文以稳定编号段落返回；同时返回总段落数、命中编号、继续位置、来源与抓取时间。超长段落拆成 1000 字符窗口，可用 `nextParagraph` 继续。正文不重复序列化为另一份全文。

`web_research` 接收 1 至 3 条彼此独立的查询，必填 `site`、`language`、`timeRange`（不限时显式传 null）和 `maxPages=1..3`。搜索与读取各最多两路并发，共享 20 秒总预算及取消信号。候选按各查询排名交错选择并去重；最多读取三个页面，每页最多 4000 字符，摘要最多 500 字符。搜索摘要仍只是候选，不代表正文核验。逐项返回错误与已有证据，不生成厂商答案、不判定答案充分性、不自动扩展查询范围。若选中的页面是 PDF，保留 `WEB_PDF_DETECTED`，由已获独立授权的 PDF 工具进一步核验。

`pdf_read` 接收必填 `action=inspect|read|find|render`、URL、`startPage`、`endPage`、`query`，以及可选 `maxCharacters`。inspect 的条件字段均为 null；read/find 必须给出最多 20 页的物理页码范围，render 仅一页，只有 find 提供关键词。inspect 只查看第一页，不能据此判断全篇都有文本。返回标题、总页数、已查看范围、逐页文本、无文本页码、截断状态与来源；find 返回关键词首次命中的上下文，render 以 Pi 原生 image 内容返回 PNG，并保留页码和尺寸。无文本页面不伪装成 OCR 成功，模型可使用页面图片查看。页面内没有文本匹配也不证明图像没有相关内容。

PDF 严格要求 `application/pdf` 与 PDF 文件头；HTML/纯文本允许类型仍只控制 `web_read`，PDF 由 `pdf_read` 独立授权控制。它复用 HTTPS、域名、每跳地址、响应体大小、出口与总下载超时校验，不让解析器访问网络、读取本机路径或接收密码。使用已有 `pdf-parse` 依赖，在 `prlimit` 与 V8 堆限制的子进程中运行：下载同时受管理员限制和 4 MiB 工具上限约束；最多 300 页、15 秒解析、两路服务端解析并发、单页最多 200 万像素及 2 MiB PNG；输出限额 4 MiB。取消时杀死解析进程。未识别出文章时返回清理后的文本，并以 `partial` 和 `ARTICLE_EXTRACTION_FALLBACK` 记录事实；提取器执行异常使用 `ARTICLE_EXTRACTION_FAILED`，保留已有正文并进入 Pi 错误事件；超出长度限制时以 `partial` 和截断元数据记录事实。

工具统一返回 `ok`、`empty`、`partial` 或 `error`。成功类响应包含 `data`、`metadata` 和事实性 `warnings`；错误包含稳定的 `code`、安全消息、`retryable`，以及可选脱敏 `details`（阶段、HTTP 状态或内容类型），不输出原始响应正文。`retryable` 只描述错误是否具备重试条件；多个供应商失败时，只要至少一个失败具备重试条件就为 `true`，纯鉴权失败为 `false`。搜索供应商健康且确实无命中时才返回 `empty`；部分引擎失败但经 URL 安全过滤后仍有结果时返回 `partial` 和 `SEARCH_PROVIDERS_DEGRADED`；无有效结果且存在引擎故障时返回 `SEARCH_PROVIDERS_UNAVAILABLE`，不再伪装成空结果。工具响应不包含 `nextAction`、行为建议或答案充分性判断，也不回显上游原始错误正文。联网结果的 Metadata 标记 `untrustedContent: true`，且始终保留来源 URL，供 Agent 引用和前端展示。

系统政策把 `web_search` 的标题与摘要定义为发现线索，而不是已核验事实。当 `web_read` 同时可用时，Agent 在回答事实问题前必须主动读取至少一个相关页面，不需要等待用户额外要求“查看页面”；发布、可用性、版本、价格、政策、法律、规格和下载优先读取官方或一手来源。页面无法读取时必须说明结论未核验。只有用户明确要求候选链接或搜索结果列表时，才可以不逐页读取直接返回搜索结果。

BugPaw 不自动安装 `web-research` Skill。上述最低路由与核验规则由有效能力快照动态注入系统提示词，用户可以另行安装调研 Skill 组织多轮查询或来源比较。工具结果只提供数据和状态，不能扩大用户指定的来源范围。

Router 会先在同一次工具调用中完成管理员配置的可用实例回退。只有全部候选都不可用并返回 `SEARCH_PROVIDERS_UNAVAILABLE` 后，隐藏 Runtime Extension 才阻止该 Run 后续 `web_search`，避免改写关键词反复请求造成限流反馈循环。断路不会终止当前任务，不影响 `web_read` 或其他工具；Agent 应使用已有证据说明临时限制。用户下一条消息开始新 Run 后恢复搜索机会，但仍遵守厂商尚未到期的 `Retry-After`。

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
6. 健康空结果、部分供应商降级和全部供应商不可用能被明确区分；同一 Run 在供应商不可用后不再重复调用搜索，但仍能继续回答或使用其他工具。

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

## 读取失败分类、Run 缓存与验收

- DNS：`WEB_DNS_FAILED`；连接/响应传输：`WEB_CONNECTION_FAILED`；总预算：`WEB_FETCH_TIMEOUT`。
- 非成功 HTTP：`WEB_HTTP_ERROR`，仅 HTTP 408、429、5xx 标记为具有重试条件；403/404 不标记可重试。
- 地址策略、资源大小、内容类型、PDF 识别与重定向分别保留明确代码与阶段。
- 网页与 PDF 同一 Run 内共享按资源类型隔离的状态。相同 URL 并发合并，成功正文或下载内容按当前策略缓存；命中缓存仍先检查全局开关，策略变化重新读取。缓存最多八条、合计 8 MiB、单条 4 MiB、五分钟有效，新 Run 清空。
- 失败 URL 在同一 Run 不再请求；末尾斜杠差异与片段不绕过失败记录，查询参数保留。返回 `WEB_READ_RETRY_BLOCKED` 与原错误代码/阶段，不吞掉失败。阻止重复请求不代表原故障不可恢复；用户下一轮重置。
- 原子工具失败通过抛出结构化协议使 Pi 标记错误事件；组合工具有失败项时抛出保留已成功取证内容的 partial 协议。仅内容截断或无文本层等明确业务状态正常返回 partial。
- 组合取消不把供应商永久记成故障，也不启动剩余读取。全部供应商不可用后，当前 Run 的 `web_search` 与 `web_research` 都遵守搜索断路，PDF 和单页读取仍可使用。

回归覆盖真实 PDF 文本/渲染、参数组合、授权快照、失败去重与下一轮恢复、缓存策略变化、URL/重定向安全、大小与 DNS 截止时间、双路取证并发和取消。测试通过不能证明外网特定网站一定可读，也不能证明端到端模型推理速度提升；应在授权新工具后对比相同问题的调用批次、失败重试及总耗时。
