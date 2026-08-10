# BugPaw 架构边界

## 分层

`src/shared` 只保存跨端契约；`src/web` 只能依赖 Shared；HTTP Route 负责认证、协议解析和状态码；Application Service 编排用例；Repository 独占 SQLite 表；Storage Adapter 独占文件系统细节；Runtime Adapter 独占 Pi SDK 生命周期。

允许依赖方向：`Web → Shared ← Route → Service → Port ← Adapter/Repository`。禁止 Web 导入 Server、Shared 导入 Node/React/Fastify、Route 直接执行 SQL、Repository 操作 UI 或 Pi SDK。

## 修改检查清单

- 新状态先判断唯一事实来源，禁止同时写 JSON 与 SQLite。
- 新 Runtime 调用必须取得并释放 `RuntimeLease`。
- 新后台任务必须有上限、取消/关闭路径和结构化错误出口。
- 新 API 必须使用 `/api/v1`、共享 `ApiErrorCode`、统一错误出口和 `requestId`。
- 修改后运行 `npm run verify`。

自动门禁：`scripts/check-architecture.ts`、TypeScript strict、Vitest、Bundle 预算和 Docker build 内 `npm run verify`。
