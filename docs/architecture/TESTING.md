# 测试与质量门禁

统一在 `node:24.19.0-bookworm-slim` 中验证。本地 Node 结果不作为交付证据。

`npm run verify` 顺序执行：TypeScript strict 类型检查、架构边界检查、全部 Vitest、Vite 生产构建、gzip Bundle 预算。默认 Docker build 只执行生产构建与 Bundle 检查；需要完整门禁时显式执行 `docker build --no-cache --target verify .`。

新增功能至少覆盖成功、认证/授权、非法输入、并发冲突、失败回滚和资源释放。Runtime/SSE 变更必须覆盖双订阅者、重连、缺口 Projection、慢客户端、跨端终止和 listener/lease 清零。Repository 变更必须使用临时 SQLite 并验证事务、外键、版本冲突和重开。

禁止通过关闭 strict、添加宽泛 `any`、跳过测试或放宽预算来修复门禁。测试数据不得包含真实凭据；错误断言只验证稳定码和脱敏字段。

## 当前基线

2026-08-08 在 `node:24-bookworm-slim` 中最终执行 `npm run verify`：TypeScript 0 错误，架构检查通过，137 个测试文件共 637 项测试通过，Vite 生产构建和 Bundle 门禁通过。

当前 gzip 预算为 JavaScript 入口 230 KiB、单个懒加载块 150 KiB、CSS 首屏 24 KiB、CSS 全站总量 64 KiB。页面 CSS 按相对首屏新增的静态依赖单独计费，所有 `src/web/pages/` 懒加载入口必须登记独立预算；聊天与知识库会额外计入 Markdown 内容样式，资源、Agent 与 AIGC 等页面按共享领域 Chunk 计费。Bundle 检查还会拒绝 Manifest 中的 Chunk 导入环，防止循环初始化导致生产白屏。新增页面预算必须先完成样式分包并根据生产构建基线设置，不得使用空页面、全局样式或缺失预算掩盖真实增量。

当前稳定性回归还覆盖：首轮崩溃 Session 清理、空 Session 定时任务拒绝、Provider 改名 Saga 启动续跑和文件/Agent 双重预算、压缩文档受限子进程的畸形输出/崩溃/超限/Abort/超时路径、慢响应主体截止、Provider 固定响应与请求凭据过滤，以及 Prompt 受理后立即 Abort 的串行语义。依赖升级必须补跑 `npm audit --omit=dev`、Pi Runtime、Mermaid 与 LanceDB 原生 FTS 测试。

浏览器验收必须使用生产构建和临时数据目录。单元/集成测试负责 Fake Runtime 下的确定性协议覆盖；真实 Provider 连通性属于部署环境检查，不能用 Mock 结果替代。
