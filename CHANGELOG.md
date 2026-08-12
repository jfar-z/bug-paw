# 更新日志 / Changelog

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

This project follows [Semantic Versioning](https://semver.org/).

## 0.1.4 - 2026-08-12

### 新增 / Added

- 增加完整的浏览器自动化能力，包括独立 Playwright Worker、受控出口代理、运行租约与公平队列、原子浏览器工具、审计记录、预览产物及权限提示。
- 增加浏览器执行配置页面、离线只读模式、配置接口与全能力部署组合，并补充安全边界和验收文档。
- 增加聊天快捷资源管理抽屉，支持安全定位工作目录资源、复用工作区浏览能力，以及 HTML 等文件的页面预览。
- 增加独立的 Provider 创建弹窗，仅需填写 ID、显示名称、模板与 Base URL；其余配置使用默认值，API Key 在创建后进入设置维护。
- 增加搜索渠道密钥获取链接，并预装 Skill 创建助手。

- Added end-to-end browser automation with an isolated Playwright worker, controlled egress proxy, fair run leasing, atomic browser tools, audit records, preview artifacts, and permission guidance.
- Added a browser-execution configuration page, offline read-only behavior, configuration APIs, a full deployment profile, and supporting security and acceptance documentation.
- Added a quick workspace-resource drawer in chat with safe working-directory links, shared workspace browsing, and page previews for HTML and other supported files.
- Added a dedicated Provider creation dialog that only requires an ID, display name, template, and Base URL; remaining settings use defaults, while API keys are configured after creation.
- Added credential-acquisition links for search providers and bundled the Skill Creator assistant.

### 修复 / Fixed

- 修复会话切换加载提示、移动端抽屉快速滑动与滚动区关闭手势，以及刷新后输入区偏移问题。
- 修复快捷资源抽屉状态残留与入场动画，并统一资源列表选择列、操作列和图标尺寸。
- 修复浏览器出口代理 Fake-IP 兼容、配置页导航与视觉层级，以及组件测试缺少运行反馈的问题。
- 修复压缩设置被误判为敏感配置并脱敏的问题，同时补充配置脱敏回归测试。
- 修复 Provider 创建弹窗的错误反馈、矮屏可达性和两组字段输入控件对齐。
- 确保已安装的 PWA 能及时发现并应用新版本。

- Fixed session-switch loading feedback, fast mobile drawer gestures, swipe-to-close behavior in scrollable areas, and composer displacement after refresh.
- Fixed stale state and entrance animation in the quick-resource drawer, and standardized selection columns, action columns, and resource icon sizing.
- Fixed Fake-IP compatibility in the browser egress proxy, browser-configuration navigation and visual hierarchy, and missing execution feedback in component tests.
- Fixed compression settings being incorrectly treated as sensitive values, with added redaction regression coverage.
- Fixed Provider creation error feedback, short-viewport accessibility, and alignment across both field pairs.
- Ensured installed PWAs promptly discover and apply new versions.

## 0.1.3 - 2026-08-12

### 新增 / Added

- 增加会话树分支导航、历史消息编辑、回答重新生成、附件回填与分支版本切换。
- 增加长会话历史分页和向上加载能力，并保持加载前后的滚动位置。
- 增加会话多选、批量归档，以及已归档会话的全部恢复与全部删除流程；关联定时任务时提供强化确认。
- 增加粘贴、拖放上传、消息纯文本复制和移动端会话侧栏滑动手势。
- 增加标题模型来源配置、思考协议参数预览，以及后台自动生成和实时同步会话标题。
- 增加知识库混合检索、上下文读取、统一检索工具响应协议和动态检索路由策略。
- 增加博查与 Tavily 搜索渠道、多实例凭证管理、搜索服务路由、冷却和运行内断路能力。
- 增加联网搜索配置弹窗、作用域说明、已配置渠道管理和配置导入迁移界面。
- 增加按事件顺序展示的思考与工具活动轨迹，包括参数生成进度、运行状态、分组、折叠和中止结果。
- 增加统一的前端接口错误分发、意外错误提示和可展开错误详情。
- 增加可选容器构建验证流程。

- Added session-tree branch navigation, historical-message editing, response regeneration, attachment restoration, and branch-version switching.
- Added paginated loading for long conversation histories while preserving the scroll position.
- Added multi-select session archiving and restore/delete-all workflows for archived sessions, with reinforced confirmation for linked scheduled tasks.
- Added paste and drag-and-drop uploads, plain-text message copying, and mobile sidebar swipe gestures.
- Added title-model source configuration, thinking-protocol previews, and background session-title generation with realtime synchronization.
- Added hybrid knowledge retrieval, contextual reads, a unified retrieval-tool response protocol, and dynamic retrieval routing policies.
- Added Bocha and Tavily search providers, multi-instance credential management, provider routing, cooldowns, and in-run circuit breaking.
- Added web-research configuration dialogs, scope guidance, configured-provider management, and configuration migration interfaces.
- Added event-ordered thinking and tool activity timelines with argument-generation progress, runtime states, grouping, collapsing, and cancellation outcomes.
- Added unified frontend API-error dispatch, unexpected-error toasts, and expandable error details.
- Added an optional container-build verification workflow.

### 修复 / Fixed

- 修复流式生成、分支发送和历史消息编辑过程中用户消息与 Agent 回答的顺序问题。
- 修复重新生成期间来源用户消息短暂消失，并统一普通发送、编辑发送、快照恢复和历史分页的消息连续性规则。
- 修复会话标题后台生成的并发、销毁日志和列表刷新问题。
- 修复实时连接恢复后中断提示残留，以及旧快照覆盖新会话状态的问题。
- 修复工具活动的状态语义、错误与中止展示、参数流式进度和活动卡片对齐。
- 修复联网搜索空结果重复重试、冷却期限和重复空参数工具调用。
- 修复归档批量确认弹窗层级、会话菜单底部遮挡和聊天内容溢出。
- 修复普通代码块无法自动换行，同时保持图表源码横向滚动。
- 修复用户消息操作区宽度、气泡底部留白和思考内容关闭状态。

- Fixed user-message and Agent-response ordering during streaming generation, branch sends, and historical-message editing.
- Fixed the source user message disappearing during regeneration, and unified continuity rules across normal sends, edited sends, snapshot recovery, and history pagination.
- Fixed concurrency, teardown logging, and list-refresh issues in background session-title generation.
- Fixed stale interruption notices after realtime reconnection and old snapshots overwriting newer session state.
- Fixed tool-activity state semantics, error and cancellation displays, streamed argument progress, and activity-card alignment.
- Fixed repeated retries on empty web-search results, cooldown handling, and duplicate empty-argument tool calls.
- Fixed archived-session confirmation layering, bottom-clipped session menus, and chat-content overflow.
- Fixed wrapping for ordinary code blocks while preserving horizontal scrolling for diagram source.
- Fixed user-action widths, extra bubble spacing, and thinking-content disabled states.

## 0.1.2 - 2026-08-10

### 新增 / Added

- 会话首轮完成后，使用当前 Agent 的已选模型自动生成并保存会话标题。
- 会话标题变更通过实时事件同步到当前页面与其他已打开标签页的会话列表。

- After the first turn completes, the selected model of the current Agent automatically generates and saves a session title.
- Session-title changes are synchronized through realtime events to the current page and other open tabs.

## 0.1.1 - 2026-08-10

### 新增 / Added

- 会话列表支持手动刷新，并在移动端恢复会话时保持正确的界面状态。
- 空会话提供直接创建入口。
- 凭证输入支持脱敏展示与按需显示，同时优化配置页的加载体验。

- The conversation list supports manual refresh and preserves the correct UI state when sessions are restored on mobile.
- Empty conversations provide a direct creation entry point.
- Credential inputs support masked display and on-demand reveal, with improved loading experiences across configuration pages.

### 修复 / Fixed

- 修复自定义目录名称与 Agent 配置的联动，并调整新建 Agent 面板布局。
- 统一知识库与联网搜索能力开关的样式。
- 修正部署脚本的健康检查地址。
- 修复知识库向量批量上传，并限制内置向量模型的批次范围以保证请求兼容性。

- Restored synchronization between custom directory names and Agent configuration, and corrected the new-Agent panel layout.
- Unified the capability-toggle styling for knowledge retrieval and web research.
- Corrected the deployment script health-check address.
- Fixed batch uploads for knowledge-base embeddings and constrained built-in embedding batch sizes for request compatibility.

## 0.1.0 - 2026-08-10

首个公开版本。/ First public release.

### 新增 / Added

- 自托管的多 Agent Web 工作台，支持流式对话、工具调用和可恢复会话。
- Provider、模型、Agent、Skills、工作区文件与运行诊断配置。
- 知识库全文检索与可选的托管中文向量检索。
- 可选 SearXNG 联网搜索、网页正文读取和 SSRF 防护。
- 定时任务、文本转语音、响应式界面与 PWA 安装能力。
- 核心、搜索、向量和全能力四种 Docker Compose 部署组合。

- A self-hosted multi-Agent Web workspace with streaming chat, tool activity, and resumable sessions.
- Provider, model, Agent, Skills, workspace file, and runtime diagnostics management.
- Knowledge-base full-text retrieval with optional managed Chinese embeddings.
- Optional SearXNG web research, article extraction, and SSRF protection.
- Scheduled tasks, text-to-speech, responsive UI, and PWA installation.
- Composable Docker deployments for core, search, vector, and full modes.
