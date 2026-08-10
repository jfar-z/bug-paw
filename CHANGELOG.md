# 更新日志 / Changelog

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

This project follows [Semantic Versioning](https://semver.org/).

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
