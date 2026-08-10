# API 约定

- 健康检查固定为 `/healthz`；业务 API 固定为 `/api/v1/*`，旧 `/api/*` 不兼容回退。
- JSON 错误固定为 `{ error: { code, message, requestId, details? } }`。`code` 必须来自共享 `ApiErrorCode`，客户端只按 `code` 分支，不比较中文文案；Route 不得直接拼装错误对象。
- `requestId` 同时写入 `X-Request-Id`。未知异常返回 `INTERNAL_ERROR`，不输出堆栈、路径、凭据或原始异常。
- 写操作使用明确的资源语义和乐观锁 revision；冲突返回 `VERSION_CONFLICT`。
- SSE 事件必须带单调事件 ID；重连使用游标，游标缺口发送 `projection_required` 并由客户端重新读取 Projection。Runtime 换代会结束旧连接以触发自动重连，慢客户端只断开自身。
- 请求体、文件数量/大小、分页、扫描和队列必须引用 `SYSTEM_LIMITS`。

新增或修改 API 时，应同时更新 Shared Schema、服务端契约测试、Web Client 测试和本文档；不得在页面组件中新增裸 `/api` 路径。
