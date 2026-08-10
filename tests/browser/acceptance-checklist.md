# BugPaw 浏览器验收清单

## 验收环境

- 必须使用临时数据目录和非生产端口，不挂载真实 `pi-agent-data`。
- 桌面视口使用 1440×900，移动视口使用 390×844。
- 浏览器控制台不得出现未捕获异常；所有请求必须进入 `/api/v1`，`/healthz` 除外。
- 截图和测试数据不得包含真实凭据、认证 Header 或业务消息内容。

## 核心流程

- 首次初始化、自动进入登录、退出后重新登录。
- 创建、编辑、排序、归档和恢复 Agent；错误通过应用内组件展示。
- Provider、模型、只写凭证和 Runtime 刷新入口可操作，且不会回显凭据。
- 新建、切换、重命名、归档、恢复和删除 Session。
- 流式文本、思考、工具、终止、附件、引用、Markdown、图片预览保持既有行为。
- Workspace 浏览、搜索、上传、新建目录、移动、重命名和删除。
- Knowledge 创建、绑定、批量上传、检索、查看和删除。
- Scheduled Tasks 创建、编辑、手动执行、历史和删除。
- Resources 浏览、启停、内容查看、安装确认和卸载确认。

## 多端与恢复

- 两个独立浏览器上下文打开同一 Session，事件 ID 单调且一致。
- 第二端中途加入先得到 Projection，再继续消费增量。
- 断线重连使用游标重放；游标过旧时回退 Projection。
- 任一端终止后两端进入相同终态；并发发送仅一个成功。
- 慢客户端被隔离后，正常客户端和 Agent 生成不受影响。

## 视觉与移动端

- Light、Dark、Bug 三主题的文字、边框、焦点和错误状态可辨认。
- 桌面侧栏、页面标题、表单、表格、对话时间线和弹层无溢出。
- 移动端抽屉、遮罩、返回边界、输入框键盘区域和触摸目标正常。
- 无 `window.alert`、`window.confirm`、`window.prompt` 原生弹窗。
- PWA manifest、Service Worker 注册路径和安装能力保持不变。

## 证据记录

记录验收日期、构建提交/分支、浏览器版本、桌面/移动截图路径、控制台错误数、失败项及对应自动化测试。真实模型网络依赖无法在隔离环境验证时，必须明确记录并以 Fake Runtime 集成测试覆盖协议和多端状态机，不得宣称完成真实 Provider 端到端验证。

## 2026-08-07—08 重构验收记录

- 分支：`refactor/bugpaw-architecture`，隔离服务端口 `7180`，`tmpfs /data`，未挂载真实数据。
- 浏览器：Playwright 1.54.2 官方 Chromium 容器；桌面 1440×1000、移动 390×844。
- 生产构建核心流程：首启、模型初始化、自动登录、Agent 创建、桌面会话、三主题循环、移动端入场和知识库导航通过。
- 网络与错误：观察到的应用请求全部进入 `/api/v1`；Manifest 与 Service Worker 均返回 200；控制台错误、页面异常和失败资源请求均为 0。
- 截图：`/tmp/bugpaw-browser-acceptance/01-setup-desktop.png`、`02-agents-desktop.png`、`03-chat-desktop.png`、`04-chat-mobile.png`、`05-knowledge-mobile.png`，均已人工目检，无白屏、溢出或导航遮挡。
- 多端流式状态机由 `tests/integration/session-sync.test.ts`、`src/server/runtime/event-journal.test.ts`、`src/server/http/sse-connection.test.ts` 和 Chat Route 测试覆盖；隔离环境未调用真实 Provider，因此不把远端模型可用性计入本次验收结论。
- 验收期间发现生产自定义分包形成循环依赖并导致首屏白屏；已恢复 Vite 安全默认分包，并在 `scripts/check-bundle.mjs` 增加 Manifest Chunk 环检测，修复后重新完成上述验收。
- 最终代码收口后再次使用全新 tmpfs `/data` 重跑同一脚本；5 张桌面/移动截图已覆盖更新，结果仍为 passed，9 类业务请求全部使用 `/api/v1`，控制台错误、页面异常和失败资源请求均为 0。
