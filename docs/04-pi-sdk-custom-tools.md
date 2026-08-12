# Pi SDK 自定义工具注册规范

本 Web 系统新增供 Agent 调用的业务工具时，默认使用 Pi SDK 的 `customTools` 注册方式。除非需求明确要求 Pi Extension、外部协议或其他集成方式，不新增上游 Extension，也不 fork 或修改 Pi 上游源码。

## 注册路径

1. 在 `src/server/<domain>/` 实现工具工厂，使用 Pi SDK 的 `defineTool` 定义名称、说明、`promptSnippet`、TypeBox 参数 Schema 与 `execute`。
2. 工具执行必须由当前 Runtime 的 `agentId` 限定业务作用域；不得信任模型传入的 Agent ID，也不得跨 Agent 读取或修改数据。
3. 在 `src/server/main.ts` 创建运行时时将工具传入 `customTools`。Pi SDK 的 `tools` 是包含内置工具和自定义工具的统一白名单；工具名只有已存在于 Agent Profile 的 `allowedTools` 时才允许调用，禁止在 Runtime 创建时自动扩权。
4. 需要模型理解可选的领域工作流时，可以由用户或包在 `/data/pi/skills/<tool-name>/SKILL.md` 提供 Skill。Skill 是补充说明，不重复完整 JSON Schema，也不替代工具侧校验或必须始终生效的系统政策。BugPaw 不自动安装知识库或联网调研 Skill。

## 参数 Schema 兼容性

- 所有工具的 `parameters` 根节点必须使用 `Type.Object(...)`，序列化后必须包含 `type: "object"`。
- 禁止在根节点使用 `Type.Union`、`Type.Intersect` 或仅包含 `anyOf`、`oneOf`、`allOf` 的组合 Schema。部分 OpenAI-compatible Provider、模型工具模板和本地推理服务会把这类调用生成为缺失参数或空 `{}`。
- 枚举可以在对象属性内使用 `Type.Union([Type.Literal(...)])`；项目后续直接依赖 `@earendil-works/pi-ai` 时，也可使用 Pi 推荐的 `StringEnum`。不得只为了枚举引入未经声明的传递依赖。
- `Type.Record`、嵌套 `$ref`、条件 Schema 和复杂组合关键字仅在目标 Provider 已验证支持时使用。默认按多个 Provider 共同支持的 JSON Schema 子集设计。
- `action` 对应的条件必填字段先声明为 `Type.Optional`，再由 `execute` 显式校验。例如 `action=replace` 时必须校验 `content` 是字符串；禁止用默认值猜测模型意图。
- 对象默认设置 `additionalProperties: false`，减少模型生成未声明字段；如果业务确实需要动态键，必须在设计和测试中说明目标 Provider 的兼容性。

推荐的单工具多操作形式：

```ts
const tool = defineTool({
  name: "example_tool",
  label: "示例工具",
  description: "读取或替换示例内容。",
  parameters: Type.Object({
    action: Type.Union([Type.Literal("read"), Type.Literal("replace")]),
    content: Type.Optional(Type.String({ description: "replace 操作写入的完整内容" })),
  }, { additionalProperties: false }),
  async execute(_toolCallId, params) {
    if (params.action === "replace" && typeof params.content !== "string") {
      return failure("replace 操作必须提供 content");
    }
    return success(await service.run(params));
  },
});
```

## 执行与安全要求

- 参数 Schema 采用 TypeBox，必填字段、最小值和对象属性内的枚举在 Schema 中表达；跨字段条件由 `execute` 校验。
- Pi SDK 会在调用 `execute` 前校验参数。校验失败时必须让调用失败，禁止把空 `{}` 补成默认参数后继续执行写操作。
- `execute` 在服务层再次校验资源归属和业务约束；返回可纠正的错误信息，不泄露凭证、认证 Header 或其他 Agent 数据。需要让 Pi 事件明确标记 `isError: true` 时应抛出异常，普通文本失败结果不会自动变为错误事件。
- 变更操作只写应用持久化数据；涉及 Pi 原生配置时遵循“保存后由系统诊断刷新”的既有约定。
- 工具名使用稳定的 `snake_case`；修改或删除优先要求明确资源 ID，避免按名称猜测。
- 如果 `bash`、`write` 等通用工具能够修改同一资源，自定义工具不能被视为强安全边界。必须通过 allowlist、工作区隔离或文件权限保证真正的写入边界。

## Provider 与流式调用

- Pi 的 OpenAI-compatible Provider 会把 TypeBox Schema 基本原样传给模型服务；不能假设 SDK 会替不同 Provider 自动降级复杂 Schema。
- 本地 Qwen 推理服务需要多轮 thinking 时，模型 `compat.thinkingFormat` 应配置为 `qwen-chat-template`。当前 Pi SDK 会据此发送 `preserve_thinking: true`；配置保存后仍需通过“系统诊断 → 刷新 Pi 配置”重建 Runtime。
- 新会话偶尔恢复正常不代表 Schema 已兼容。复现时至少对照第一回合/多回合、流式/非流式和新前缀/缓存前缀。
- 诊断空参数时，只记录 `provider`、`model`、`sessionId`、工具名、连续计数、处理动作和最终参数状态。参数状态区分 `missing`、`empty_object`、`malformed` 与 `valid`；不得记录参数明文。
- Pi SDK 的 `tool_call` 扩展钩子发生在参数 Schema 校验之后，不能用来拦截 `{}` 等校验失败调用。断路必须接在 BugPaw Runtime 的 `tool_execution_start` 事件层；该事件发生在 Schema 校验之前，且 SDK 会等待内部事件链完成。
- 对 Schema 声明了必填字段的自定义工具，同一 Run 内连续收到缺失、空对象或畸形参数时，前两次保留 SDK 正常校验错误；第三次由 Runtime 同步请求 `abort`，在业务 `execute` 前终止当前 Agent Run。断路不得关闭 Session，用户下一条消息开始新 Run 后重新计数。不得通过默认参数猜测意图，或回退到更高权限工具绕过原工具的业务边界。
- 断路诊断只记录 `sessionId`、`provider`、`model`、工具名、参数状态、连续计数和 `allowed/terminated` 动作，不记录参数正文。工具返回内容不包含 `nextAction`，也不能改变用户目标或扩大检索范围。
- 上游服务不可用与空参数属于两类断路：前者可在合法工具结果返回稳定错误码后，通过 `tool_result` 记录状态，并在 `tool_call` 阻止同一 Run 的后续同名调用。此类断路只阻止工具重试，不设置 `terminate`、不请求 `abort`，也不关闭 Session；下一 Run 必须重置。断路只识别项目统一错误码，不依赖具体上游供应商的原始错误正文。

## 测试要求

- 每个工具至少覆盖成功、参数错误、越权/资源不存在三个场景；有全局 Skill 时测试其关键章节或约束已落盘。
- 测试必须断言 `tool.parameters.type === "object"`，并断言根节点不存在 `anyOf`、`oneOf` 或 `allOf`。
- 含条件参数时，必须覆盖缺少条件必填字段且没有产生副作用的场景。
- 新增 Provider 专用 Schema 关键字时，必须增加对应 Provider 的最小请求回归测试或记录可重复的人工验收步骤。

## 定时任务示例

`scheduled_tasks` 由 `createScheduledTasksTool(agentId, service)` 创建，运行时只注入当前 Agent 的服务作用域。它的全局 Skill 说明 Cron、时区、目标会话及执行行为；真实字段校验仍在 TypeBox Schema 与服务层完成。
