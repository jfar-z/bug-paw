# 可靠性约束

BugPaw 保证单个服务实例内，多浏览器客户端观察同一 Session 的同序事件与最终 Projection；不宣称支持多个服务副本。实例锁阻止同一数据目录被两个进程写入。

Runtime 由 `RuntimeSupervisor` 以 Agent/Generation 管理。所有请求、SSE 和定时任务使用租约；刷新会通知旧代长连接结束并自动重连当前代，等待租约释放后销毁；关闭时先停止调度、终止生成、排空任务与 Runtime，再关闭 SQLite。Session 打开单航班，Turn 互斥。

Event Journal 上限为 2000 条/8 MiB，单个实时事件 512 KiB；客户端队列 512 条/2 MiB；检查点 1 秒合并、5 秒强制刷新。Workspace 扫描为 20 层/10000 项/10 秒；知识上传单文件 20 MiB、单批总量 50 MiB；任务历史、资源日志和预览注册表均有上限与 TTL。

PDF/DOCX 在独立子进程中解析，Linux 地址空间上限 2 GiB、V8 Old Space 上限 128 MiB、输出上限 24 MiB、超时 45 秒；PDF 最多 500 页，DOCX 在解压前检查条目数和解压体积。批量资料逐文档解析、索引和提交，不同时保留整批正文与切片。部署镜像必须提供 `/usr/bin/prlimit`，缺失时解析请求安全失败而不回退主进程。

Agent 与知识资料删除采用“同卷暂存—数据库提交—回收区清理”。数据库提交失败时逆序恢复目录，知识索引按恢复后的正文重建；清理回收区失败不反向伪造已提交操作失败。

Provider 改名采用 durable Saga：先写恢复清单，再提交 Pi 配置和 Session JSONL，最后更新 Agent SQLite 引用；崩溃后启动流程先恢复配置事务，再根据当前 Provider 事实幂等前滚或回退 Agent 引用。会话历史迁移最多 500 个文件、16 MiB 和 20 层目录，单次最多迁移 500 个 Agent 引用；写入与恢复清单使用同一上限。

Pi 首条 Assistant 消息完成前没有 JSONL。若进程在此窗口崩溃，启动协调器删除没有任何匹配 JSONL 的 Session 元数据、绑定任务和运行检查点；系统不伪造或猜测未落盘的用户消息。尚无 JSONL 的空 Session 禁止成为定时任务目标，避免正常重启时把用户任务误判为孤儿数据。

所有 Provider 网络请求都必须同时约束连接和响应主体读取。连通性测试只允许返回固定 `OK` 状态，任何其他远端正文不回显；失败只返回固定消息。模型发现会收集本次 URL 和 Header 中实际发送的凭据，并丢弃等于或包含这些凭据的模型 ID，不能依赖敏感字段名猜测完成脱敏。

Session Registry 最多同时跟踪 256 个已打开或正在打开的 Session；容量判断必须包含 pending open，避免并发打开绕过上限。Runtime 诊断公开活动租约数和受跟踪 Agent 数，已无 current/pending/retired generation 的 Agent 必须从状态表移除。

禁止裸 `void promise`、空 Catch 和无界 Map/数组。后台失败进入 `BackgroundErrorRegistry` 并记录稳定错误码；清理失败可以降级为 Warning，但持久化和 Runtime 失败必须可诊断。

生产构建必须通过 Chunk 环检测。禁止为追求更小文件而强制拆分相互初始化的第三方依赖；如需调整分包，必须先运行生产浏览器验收，再调整 gzip 预算。
