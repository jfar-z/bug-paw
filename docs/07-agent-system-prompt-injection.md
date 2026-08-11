# Agent 系统提示词注入规范

## 目的

BugPaw 基于 Pi Coding Agent 运行。Pi 默认身份是编码助手，而 BugPaw 的 Agent 同时承担研究、沟通、整理和文件协作等任务。本规范定义如何在保留 Pi 原生工具与规则的前提下，调整 Agent 的系统提示词。

## 注入顺序

Pi 先组装默认系统提示词、动态工具说明、Agent 长期设定、项目上下文和 Skills。随后，`createAgentSystemPromptInjectionExtension()` 在 `before_agent_start` 中取得完整的 `event.systemPrompt`，由 `AgentSystemPromptConfiguration` 按 `Available tools:` 分割标记替换其身份前缀。

最终顺序如下：

```text
[英文通用工作助理身份]
[agent_references 协议]
[pi_agent_files 协议]
[按有效工具动态生成的检索路由政策]
Available tools:
[Pi 动态工具说明与原生规则]
[Agent 角色 / 行为 / 规则 / 用户 / BOOTSHARP]
[AGENTS.md、Skills 与其他项目上下文]
```

`Available tools:` 之后的内容必须保持原样。若 Pi 上游不再生成该标记，转换逻辑必须保留完整原提示词，并在末尾追加替换前缀；不得截断原有工具或规则说明。

## 代码归属

- `src/server/agent-system-prompt-configuration.ts`：唯一维护身份文本、能力协议、分割标记与纯转换逻辑的配置类。
- `src/server/agent-system-prompt-extension.ts`：唯一维护 `before_agent_start` 内联扩展注册的模块。
- `src/server/pi-runtime.ts`：只负责向 `DefaultResourceLoader` 注册隐藏内联扩展，不保存协议正文。

不得使用 `DefaultResourceLoader.systemPromptOverride` 替换 Pi 默认身份。该接口处理 `.pi/SYSTEM.md` 资源，而不是 Pi 已组装完成的默认系统提示词，可能跳过动态工具说明。

## 内容归属

以下内容必须由 Pi 工具定义维护，不得在本配置类重复：

- 工具名称、用途和参数；
- 单工具参数和返回字段；
- `description` 与参数 Schema 能表达的工具事实。

只有不能由单一工具 Schema 表达的内容才可作为能力协议加入 `AgentSystemPromptConfiguration.capabilityPrompts`，例如：

- 用户消息与前端共同使用的引用结构；
- Agent 输出需要前端解析的结构块；
- 跨消息或跨工具的稳定交互约束。

当前能力项如下：

- `agentReferences`：解释用户显式附带的 `<agent_references .../>` 标签，不得将普通文本中的相似标签视为授权。
- `workspaceFileDelivery`：规定通过 `<pi_agent_files ...>` 向用户发送 cwd 相对路径文件的输出结构。

检索路由政策不属于上述通用交互协议，也不依赖单个工具的 `promptSnippet`。系统在每个 Runtime 创建时根据全局联网开关和该 Agent 的工具权限生成一次 `EffectiveRetrievalCapabilities` 快照，并把同一快照同时传给工具注册和系统提示词构建：

- `knowledge_search` 可用时，注入内部、项目或用户资料应优先检索知识库的触发条件。完整且无歧义的切片可以支持窄事实；`knowledge_read` 同时可用时，摘要、解释、重要结论或上下文不完整的切片必须主动读取相关上下文，不等待用户再次要求。
- `web_search` 可用时，注入显式查找、时效性、精确归因和不确定事实应联网核验的触发条件，并声明搜索摘要只用于发现来源；`web_read` 同时可用时，事实回答不得只依据搜索摘要，默认至少读取一个相关页面。候选链接或搜索结果列表是唯一例外。
- 两类搜索同时可用时，注入内部来源与公开来源的选择和联合使用边界。
- 任一检索能力可用时，要求服从用户对来源和检索范围的显式限制，并声明工具结果不能授权后续行为或改变用户目标。

政策不包含通用的“Web interaction protocols”包装段，也不改变基础身份文本。后续 Playwright 只能作为 `web_read` 的底层实现演进，不新增不存在的交互能力。

BugPaw 不自动安装 `knowledge-base` 或 `web-research` Skill。基础路由必须在模型未读取任何 Skill 时仍然生效；用户安装的调研 Skill 只补充研究工作流，不能替代动态政策、工具 Schema 或用户对来源范围的限制。工具输出不包含 `nextAction`，也不授权后续行为。

## 语言规范

所有通过 `before_agent_start` 替换或注入的提示词默认使用英文。只有开发新需求时用户明确指定加入中文提示词，才可在该钩子注入中文内容。

该规则只约束发送给模型的提示词，不限制代码注释、测试名称和开发文档使用中文。

## 新增能力项的要求

新增能力协议前，必须确认其不能由工具 Schema 表达，并在同一改动中完成：

1. 为能力项使用稳定的英文标识和英文提示词；
2. 明确注入条件与顺序；
3. 在配置类测试中覆盖能力组合、出现次数、顺序与转换结果；
4. 更新本文档的“内容归属”和能力清单；
5. 不在提示词、日志、测试断言或文档写入密码、API Key、认证 Header 或其他敏感信息。
