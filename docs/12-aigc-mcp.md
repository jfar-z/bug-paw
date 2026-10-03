# AIGC 外部 MCP 接口

## 开放与认证

1. 在 AIGC 工作台的接口编辑区勾选“开放给外部 MCP”并保存。该开关与“发布为 Agent 工具”独立，历史接口默认关闭 MCP。
2. 在同一页面展开“外部 MCP 客户端”，选择接口和允许的操作后创建令牌。令牌明文仅在创建时显示一次；服务端只保存 SHA-256 哈希。
3. 外部客户端使用 Streamable HTTP 地址 `https://<可达域名>/api/v1/aigc/mcp`，每个请求携带 `Authorization: Bearer <令牌>`。内网也可使用可达的内网地址。服务本身的监听地址和端口由部署配置决定。

撤销客户端、关闭接口 MCP 开关或停用渠道会立即阻止新的工具调用与产物读取。管理员仍可在工作台查看历史任务和文件。令牌不要放入 URL、日志或仓库。

## 工具

| 工具 | 所需操作 | 说明 |
| --- | --- | --- |
| `aigc_list_interfaces` | `list` | 分页发现接口，按真实 ID 读取入参与出参定义 |
| `aigc_upload_input` | `upload` | 以 base64 上传不超过 8 MiB 的媒体，返回 `inputId` |
| `aigc_run` | `run` | 异步提交任务，返回 `taskId` |
| `aigc_get_task` | `get` | 查询进度和产物元数据，遵守返回的 `pollAfterMs` |
| `aigc_read_output` | `download` | 以 base64 读取不超过 8 MiB 的产物 |
| `aigc_cancel_task` | `cancel` | 取消当前客户端的任务 |

接口发现首次传 `{ "action": "list", "interfaceId": null, "offset": 0 }`；读取详情传 `{ "action": "get", "interfaceId": "<列表中的 ID>", "offset": null }`。媒体字段在详情中标记 `source: "upload"`，其 `value` 必须是该客户端上传获得的 `inputId`。普通字段使用原生 JSON 字符串、数字或布尔值。任务提交示例：

```json
{
  "interfaceId": "<接口 ID>",
  "requestKey": "cover-001",
  "parameters": [
    { "name": "prompt", "value": "城市天际线" },
    { "name": "image", "value": "<inputId>" }
  ]
}
```

同一客户端重复使用相同 `requestKey` 和参数会返回既有任务；参数变化则报冲突。新键表示新计费任务。任务仍使用现有 AIGC 引擎、状态与取消语义；MCP HTTP 请求不会等待最长 30 分钟的生成过程。

## 大文件

大于 8 MiB、最多 100 MiB 的输入文件可通过 `POST /api/v1/aigc/mcp/uploads` 以 `multipart/form-data` 上传，字段名为 `file`，使用同一 Bearer 令牌；响应包含 `inputId`。单任务媒体输入总量最多 200 MiB。无需公网可达的输入 URL；Grok 所需的公开 URL 由服务端按现有部署配置生成。

上传接受 PNG、JPEG、WebP、GIF 图片，MP4、WebM、MOV、MKV 视频，以及 MP3、WAV、FLAC、OGG、M4A、AAC 音频；不接受可执行的 SVG 文档。

未提交任务的上传文件有效期为 24 小时，每个客户端的未使用输入最多占用 500 MiB；下一次上传时清理过期且未被任务引用的文件。被任务引用的输入保留供任务历史使用。

`aigc_get_task` 成功后返回每个文件的 `id`、`outputId`、`outputName`、`mediaType`、`size` 和相对 `downloadPath`。大于 8 MiB 的产物使用 `GET downloadPath` 并携带同一 Bearer 令牌下载；不在 MCP JSON 里塞入大文件。下载时会再次校验令牌、客户端任务归属及接口发布状态。下载路径与 MCP 地址共用同一站点，不应转交给其他客户端。

## 边界

- MCP 客户端与内部 Agent 共用部署侧配置的全局活动任务上限、单客户端活动任务上限、小时提交上限及查询最小间隔。
- MCP 令牌只访问授权的接口和操作。内部 Agent 工具权限、工作区路径和浏览器登录 Cookie 均不能代替 MCP 令牌。
- 任务及上传文件按客户端隔离；手动任务和其他客户端的任务不可读取或取消。
- 接口出参定义标识 `outputId` 与文件 ID 分开返回，多文件映射保留同一出参身份。
