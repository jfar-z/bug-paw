import type { BrowserGrantedPermission } from "./browser-automation-contracts";

/** Worker 读取的临时上传文件。 */
export interface BrowserWorkerUpload {
  /** Worker 临时目录中的不透明文件标识。 */
  handle: string;
  /** 安全化的展示文件名。 */
  name: string;
  /** 文件 MIME。 */
  mediaType: string;
}

/** 主服务允许 Worker 使用的短期出口范围。 */
export interface BrowserEgressGrant {
  /** Browser Run Lease 标识。 */
  leaseId: string;
  /** 授权到期时间戳。 */
  expiresAt: number;
  /** 可使用 HTTP 或私网例外的精确 Origin。 */
  trustedOrigins: string[];
}

/** Worker 只接受原子命令，不接收自然语言目标。 */
export type BrowserCommand =
  | { type: "open"; target: { kind: "url"; url: string } | { kind: "preview"; url: string }; newPage: boolean }
  | { type: "snapshot"; pageId?: string; maxCharacters: number }
  | { type: "click"; pageId?: string; ref: string }
  | { type: "scroll"; pageId?: string; ref?: string; direction: "up" | "down" | "left" | "right"; amount: "small" | "medium" | "large" }
  | { type: "input"; pageId?: string; ref: string; text: string }
  | { type: "submit"; pageId?: string; ref: string }
  | { type: "upload"; pageId?: string; ref: string; files: BrowserWorkerUpload[] }
  | { type: "screenshot"; pageId?: string; mode: "viewport" | "fullPage" | "element"; ref?: string; format: "png" | "jpeg"; quality?: number }
  | { type: "download"; pageId?: string; source: { kind: "url"; url: string } | { kind: "element"; ref: string } };

/** 创建临时 Browser Context 的内部请求。 */
export interface CreateBrowserContextRequest {
  /** 主服务分配的租约。 */
  leaseId: string;
  /** 本 Context 的受控出口。 */
  egress: BrowserEgressGrant;
  /** 可授予的有限浏览器权限。 */
  permissions: BrowserGrantedPermission[];
  /** 单 Context 页面上限。 */
  maxPages: number;
}

/** 执行单个原子命令的内部请求。 */
export interface ExecuteBrowserCommandRequest {
  /** 当前租约标识。 */
  leaseId: string;
  /** 待执行命令。 */
  command: BrowserCommand;
}

/** Worker 暂存的、只能读取一次的二进制产物。 */
export interface BrowserWorkerArtifactHandle {
  /** 不透明的一次性标识。 */
  handle: string;
  /** Worker 识别出的 MIME。 */
  mediaType: string;
  /** 产物字节数。 */
  size: number;
  /** 浏览器建议的文件名。 */
  suggestedName?: string;
}

/** Worker 的 JSON 响应信封。 */
export type BrowserWorkerResponse<Data = unknown> =
  | { status: "ok"; data: Data }
  | { status: "error"; error: { code: string; message: string; retryable: boolean } };
