# ADR-0001：使用 SQLite 保存 BugPaw 应用状态

- 状态：已接受
- 日期：2026-08-07

## 背景

当前应用把身份、Agent、定时任务、知识库元数据和其他状态分散保存在多个 JSON 文件中。多数写入采用“读取—修改—覆盖”方式，并发请求可能丢失更新；跨文件修改只能依靠补偿和恢复清单，不能提供真正的原子提交。系统尚未上线，用户允许备份后清空现有数据，因此可以一次性调整数据模型而不维护旧格式兼容层。

Pi 原生配置、Pi Session JSONL、LanceDB 索引和用户工作目录各有独立格式与生命周期，不应被重复建模到应用数据库中。

## 决策

使用 Node.js 24 提供的 `node:sqlite`，在 `/data/app/bugpaw.sqlite3` 中保存 BugPaw 应用状态。启用外键、WAL、`busy_timeout` 和显式事务；所有 SQL 只能位于 Repository 实现中，Schema 变化只能新增版本化 Migration。

SQLite 保存：

- 应用初始化、密码凭据摘要、用户及 Web Session；
- Agent Profile、排序、修订版本；
- Session 与 Agent 的归属、归档和显示元数据；
- 定时任务及有界运行历史；
- 知识库、Agent 绑定和文档元数据；
- 配置变更记录、快照索引及数据库 Schema 版本。

SQLite 不保存：

- `/data/pi/models.json`、`auth.json`、`settings.json` 的替代副本；
- Pi Session JSONL 的消息副本；
- Agent Markdown 指令、工作目录、头像和知识源文件内容；
- LanceDB 向量与全文检索索引；
- 可从上述事实来源重新生成的临时缓存。

## 结果

应用状态写入可通过事务、外键和唯一约束保证一致性，并消除 JSON 覆盖写造成的并发丢失。备份必须同时覆盖 SQLite 主文件、WAL/SHM 文件以及保留的文件型事实来源，因此运行中备份应通过受控快照，停机备份可以直接覆盖整个数据目录。

代价是运行环境固定到 Node.js 24，且需要维护 Migration、Repository 和数据库测试。开发者不得绕过 Repository 直接执行 SQL，也不得把 Pi 原生数据镜像进 SQLite 形成双重事实来源。

## 被否决的方案

- 继续使用 JSON 并增加进程内互斥：无法覆盖跨文件事务和多进程误启动。
- 引入外部 PostgreSQL：对当前单实例个人工作台增加不必要的部署与运维成本。
- 把所有数据放入 SQLite：会复制 Pi 和 LanceDB 已拥有的数据，增加一致性风险。
