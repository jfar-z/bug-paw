# 浏览器执行能力与安全边界

BugPaw 的浏览器能力由现有 Agent 直接控制，不引入第二层任务规划 LLM。主服务负责可信身份、权限、队列、租约、产物与审计；独立 Playwright Worker 只执行类型化原子命令；受控出口代理负责协议、DNS 与目标地址校验。

## 第一期能力

Agent 可按权限使用九个工具：`browser_open`、`browser_snapshot`、`browser_click`、`browser_scroll`、`browser_screenshot`、`browser_download`、`browser_input`、`browser_submit` 和 `browser_upload`。新建 Agent 默认只获得前六个只读浏览工具；输入、提交和上传必须由管理员单独授权。

受信任 Origin 与本地静态页面分别配置文本输入、表单提交、文件上传、剪贴板读取和剪贴板写入。所有开关默认关闭；摄像头、麦克风、定位、通知和系统授权弹窗不在第一期允许清单中。

公开浏览固定为 HTTPS。空域名清单表示允许所有公网 HTTPS 站点，但回环、私网、链路本地、保留地址、云元数据、多播、IPv4 映射地址和 DNS 重绑定仍会被出口代理拒绝。受信任 UI 必须配置精确的 Scheme、Host 和 Port，不支持通配符。

直连网络应保持 `BUG_PAW_BROWSER_TRUSTED_FAKE_IP_CIDRS` 为空。如果部署侧 DNS 使用 Clash 等 Fake-IP 模式，可显式填写其合成地址网段；该例外只允许 HTTPS 代理连接，不会放行 HTTP、云元数据或未登记的受限地址。

## 永久禁止的操作

即使管理员打开交互开关，也不会允许密码、MFA、恢复码、API Key、支付字段、账号安全和删除账号操作。Worker 不提供任意 JavaScript、CSS/XPath 选择器、Cookie、Storage、任意 Header、浏览器启动参数或系统授权弹窗点击。

## Context 与资源池

Browser Context 属于一次 Agent Run，而不是一次 Session 或一次工具调用。同一 Run 的多次浏览器调用复用 Context；下一条用户 Prompt 会创建新 Run 和新 Context。默认全局同时运行 1 个 Context、单 Agent 1 个、队列容量 10、排队等待 30 分钟、孤儿回收 15 分钟、Run 总时限 90 分钟。排队保持当前 function call 阻塞，并用工具更新告知 Agent 前方任务数。

Worker 重启后不会伪造恢复旧页面。第一期不保存 Cookie、Storage State 或 Profile，但认证状态 Provider 和 Run 归属已留出扩展边界；后续登录态应按用户与 Agent 明确隔离，并使用加密、可撤销的持久化状态。

## 本地页面、上传与产物

本地 HTML 只接受当前 Agent 工作区相对路径，通过一次性内部 Origin 提供；不使用 `file://`，不挂载整个工作区，并拒绝路径穿越、目录和符号链接。上传文件也会重复执行 realpath 边界检查，再复制到 Worker 私有临时目录。

截图和下载经一次性句柄流回主服务，保存到 `browser-artifacts/YYYY-MM-DD/<task-id>/`。默认单下载 50 MiB、单 Run 200 MiB，拒绝可执行文件、安装包、脚本包和未知二进制。manifest 与审计不记录页面正文、输入值、Cookie、认证 Header 或请求体。

## 部署与排障

使用 `./scripts/deploy.sh browser` 部署核心服务加浏览器组件，或使用 `./scripts/deploy.sh full` 部署全部能力。脚本在数据目录原子生成 mode `600` 的内部通信密钥且不会打印密钥；Worker 与代理使用同一专用 UID 读取它。Worker 与出口代理不发布宿主端口，使用只读根文件系统、独立 control/egress 网络和资源上限。

配置入口为“配置中心 → 能力扩展 → 浏览器执行”，稳定路径是 `/settings/capabilities/browser`。工具因权限被拒绝时会返回错误码、所需设置字段、配置路径和可转述的用户指引。部署状态测试只检查内部 Worker 与 Chromium，不访问任意第三方网站。
