# 更新日志 / Changelog

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

This project follows [Semantic Versioning](https://semver.org/).

## 0.1.7 - 2026-08-22

### 新增 / Added

- 增加 ComfyUI 参考输入组，可按工作流拓扑汇总图片、视频与音频输入，支持搜索汇总节点、渐进式槽位展示，以及入参与出参的拖动排序。
- 增加 AIGC 轻量媒体剪辑工作台，支持从产物库编排图片、视频与音频片段，调整片段顺序、裁剪区间、图片时长和原音状态，并连续预览和串行导出视频或音频。

- Added ComfyUI reference-input groups that derive image, video, and audio inputs from workflow topology, with aggregate-node search, progressive slots, and drag-and-drop ordering for inputs and outputs.
- Added a lightweight AIGC media editor for arranging image, video, and audio outputs, adjusting clip order, trim ranges, image duration, and source audio, with continuous previews and serialized video or audio exports.

### 修复 / Fixed

- 修复 ComfyUI 动态节点实例的参数元数据推导、枚举与数值约束合并、冲突标记、运行表单控件和服务端映射校验。
- 修复 ComfyUI 输入预览与公开文件选择，并优化参考输入组在运行页的全宽布局。
- 修复 ComfyUI 工作流控件、PrimitiveNode 与旁路节点转换，确保只提交实际启用的媒体分支并保留有效下游连接。
- 修复快捷资源文件预览在滚动后被固定列表头遮挡的问题，预览期间隐藏资源表格并清理冗余层级。

- Fixed parameter-metadata inference, enum and numeric constraint merging, conflict reporting, runtime controls, and server-side mapping validation for dynamic ComfyUI node instances.
- Fixed ComfyUI input previews and public-file selection, and improved full-width reference-group layout on the run page.
- Fixed ComfyUI widget, PrimitiveNode, and bypass-node conversion so only active media branches are submitted while valid downstream links are preserved.
- Fixed quick-workspace file previews being obscured by sticky table headers after scrolling by hiding the resource table during previews and removing redundant stacking rules.

## 0.1.6 - 2026-08-20

### 新增 / Added

- 增加完整的 AIGC 工作台，统一管理渠道、协议接口、创作运行与使用入口，支持 OpenAI、Grok 和 ComfyUI 能力。
- 补齐 Grok 图片编辑、视频编辑续写，以及通过公共文件区选择媒体输入的工作流。
- 重构 AIGC 信息架构与创作运行界面，提供紧凑参数布局、媒体产物切换预览和清晰的运行状态反馈。
- 增加 AIGC 产物查看、任务与产物级联删除、缩略图分组分页、公开目录管理和稳定公开 URL。
- 增加 ComfyUI 可视化拓扑编排、条件分支映射、媒体输出节点选择，以及无需手工指定字段的图片、视频和音频产物映射。
- 增加 ComfyUI 本地上传、公开目录和服务端 input 目录三种媒体输入路径，并支持图片、视频与音频参数。
- 增加 ComfyUI 节点元数据同步、枚举和值域表单控件、并发同步与 revision 保护，同时兼容新版和旧版 COMBO 元数据。
- 增加本地语音输入能力，在支持的浏览器中直接将录音转为会话输入文本。
- 拆分独立页面与 AIGC 页面样式，增加逐页面 Bundle 预算、PWA 预缓存合同和公开 Web 页面分包规范。

- Added a complete AIGC workbench for channels, protocol interfaces, creation runs, and usage entry points across OpenAI, Grok, and ComfyUI capabilities.
- Completed Grok image editing, video editing and continuation, plus media inputs selected from the public file area.
- Redesigned AIGC information architecture and creation runs with compact parameter layouts, switchable media previews, and clearer runtime feedback.
- Added AIGC output browsing, cascading task/output deletion, grouped thumbnail pagination, public-directory management, and stable public URLs.
- Added visual ComfyUI topology composition, conditional branch mapping, media-output node selection, and field-free mapping for image, video, and audio outputs.
- Added three ComfyUI media-input paths: local uploads, the public directory, and the server-side input directory, with image, video, and audio parameters.
- Added ComfyUI node-metadata synchronization, enum/range controls, bounded concurrent sync, revision protection, and compatibility with both new and legacy COMBO metadata.
- Added local speech input so supported browsers can transcribe recordings directly into the conversation composer.
- Split page-specific and AIGC styles, introduced per-page bundle budgets and PWA precache contracts, and documented the public Web page-splitting standard.

### 修复 / Fixed

- 修复 AIGC 详情跳转重复触发移动端入场层，以及会话输入区在样式分包后的背景断层。
- 修复 ComfyUI 长任务轮询上限、音频输入输出、WebSocket 节点进度、瞬态状态、长状态截断和运行中重复提交。
- 修复 ComfyUI 节点浏览返回入口、节点列表静默截断，以及超过十二个节点后无法访问全部映射目标的问题。
- 修复 ComfyUI 视频产物写入 images 槽位时无法识别，并完善媒体输出回退逻辑。
- 修复快捷资源管理样式未随聊天页面加载、抽屉标题信息挤成单行及关闭按钮错位。
- 修复移动端快捷资源抽屉未覆盖完整视口而露出白边的问题。
- 修复文件预览时固定的“选择”和“操作”列表头遮挡预览内容的问题。

- Fixed duplicate mobile entrance layers during AIGC detail navigation and the composer background seam introduced by style splitting.
- Fixed ComfyUI long-run polling limits, audio inputs/outputs, WebSocket node progress, transient states, long-status truncation, and duplicate submissions while running.
- Fixed ComfyUI node-browser return navigation, silent node-list truncation, and inaccessible mapping targets beyond twelve nodes.
- Fixed detection of ComfyUI video artifacts emitted through image slots and strengthened media-output fallback behavior.
- Fixed quick-workspace styles missing from chat, drawer-title content collapsing into one line, and the close button shifting out of place.
- Fixed the mobile quick-workspace drawer exposing a white edge instead of covering the full viewport.
- Fixed sticky selection and action headers rendering above file-preview content.

## 0.1.5 - 2026-08-15

### 新增 / Added

- 增加会话置顶、会话文本搜索与结果定位，并提供按 Agent 范围列出、搜索和读取会话内容的工具；长历史使用稳定游标与当前分支投影恢复。
- 增加 Agent 自身提示词文件的动态注入与原生文件工具维护能力，使每次运行读取最新工作区上下文。
- 预装通用深度研究 Skill，支持规划、检索、证据整理与长文交付，并强化安装路径、权限和异常根目录保护。
- 增加会话输入区的模型与思考深度控件，支持草稿继承 Agent 默认值、会话级持久化和模型能力降级。
- 增加 Agent 主动向用户提问的完整流程，包括终止工具、消息防护、问题快照、跨标签页同步、草稿缓存和回答续跑协议。
- 增加提问与回答的独立时间线展示、逐题审计卡片、实际答案标签解析，以及历史分支和分页后的回答状态恢复。
- 增加用户与 Agent 头像原图上传、固定比例裁剪、EXIF 方向处理、透明通道保留、自动压缩和 WebP 持久化。
- 增加模型级与 Agent 级 TTS 自定义请求参数，支持分层覆盖、专用音色优先和受保护字段校验。
- 升级白色、暗色与 BUG 三套主题，统一语义颜色、状态信号、浏览器主题色、滚动条、侧边栏和工作区视觉层级。

- Added pinned sessions, full-text session search and result navigation, plus Agent-scoped tools for listing, searching, and reading conversation content with stable history cursors and branch projections.
- Added dynamic injection and native file-tool maintenance for each Agent's own prompt files, loading the latest workspace context on every run.
- Bundled a general-purpose deep-research Skill for planning, retrieval, evidence synthesis, and long-form delivery, with hardened installation paths and permissions.
- Added composer controls for model and thinking depth, including Agent-default inheritance, per-session persistence, and capability-aware fallback.
- Added the complete Agent-to-user question workflow with a terminating tool, message guards, question snapshots, cross-tab synchronization, draft caching, and answer-resume protocols.
- Added separate question and answer timeline entries, per-question audit cards, authoritative answer-label resolution, and answer-state recovery across branches and history pages.
- Added user and Agent avatar uploads with fixed-ratio cropping, EXIF orientation, alpha preservation, automatic compression, and WebP persistence.
- Added model-level and Agent-level custom TTS request parameters with layered overrides, dedicated voice precedence, and protected-field validation.
- Refreshed the light, dark, and BUG themes with consistent semantic colors, status signals, browser theme colors, scrollbars, sidebars, and workspace hierarchy.

### 修复 / Fixed

- 修复聊天模型错误在快照、实时事件和新一轮生成之间的传播与清理，避免暴露上游错误正文或残留旧会话提示。
- 修复会话检索首个游标、流式搜索焦点、搜索按钮布局和结果滚动，并限制工具详情与搜索结果各自在容器内滚动。
- 修复会话实时事件误报、旧快照覆盖新状态、恢复游标失效，以及快速切换 Agent 或会话时迟到响应串入当前界面。
- 修复输入区多行排版、活动操作栏、用户消息与 Agent 活动顺序、模型菜单定位，以及移动端触控和窄屏边界。
- 修复提问创建中误报失败、答案提交后未立即回显、问题快照标签解析、未知选项保护，以及历史提问终态无法恢复。
- 修复回答续跑中的多类竞态：Run 快照先到、正文先到、答案接口先到、迟到快照覆盖和第二轮以后回答卡片顺序错误。
- 修复头像上传失败、旧 revision、损坏图片和写盘异常时的原文件保护与临时文件清理，并补充像素、体积和裁剪边界校验。
- 修复暗色与 BUG 主题状态颜色、对比度、侧边栏可读性、白色主题表面层级和浏览器主题色同步。
- 清理已失效、重复和过度绑定内部实现的测试，合并 CSS 布局回归，并将旧文案断言重写为公共交互与导航契约。

- Fixed chat-model error propagation and cleanup across snapshots, realtime events, and subsequent runs without exposing upstream error bodies or leaking stale session state.
- Fixed initial session-search cursors, streaming-search focus, search-button placement, and independent scrolling for results and tool details.
- Fixed false realtime errors, stale snapshots overwriting newer state, invalid recovery cursors, and late responses leaking across rapid Agent or session switches.
- Fixed multiline composer layout, activity controls, user/Agent timeline ordering, model-menu placement, and mobile touch and narrow-screen boundaries.
- Fixed false failures during question creation, delayed answer feedback, snapshot-label resolution, unknown-option handling, and restoration of historical question terminal states.
- Fixed answer-resume races involving run snapshots, streamed text, answer responses, late projections, and second-or-later turn answer-card ordering.
- Fixed avatar rollback and temporary-file cleanup for stale revisions, corrupt images, and write failures, with stronger pixel, size, and crop-boundary validation.
- Fixed dark and BUG theme status colors, contrast and sidebar readability, light-theme surface hierarchy, and synchronized browser theme colors.
- Removed stale, duplicate, and implementation-bound tests, consolidated CSS layout regressions, and rewrote legacy copy assertions around public interaction and navigation contracts.

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
