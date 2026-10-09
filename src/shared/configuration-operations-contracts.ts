/** 只读恢复预览绑定当前版本，不包含快照路径或凭证明文。 */
export interface ConfigurationRestorePreview {
  id: string;
  scope: "global" | "agent";
  targetId?: string;
  revision: string;
  differences: Array<{ field: string; current: string; restored: string }>;
}

/** 提交后维护错误需保持具体错误及已提交事实。 */
export interface ConfigurationPostCommitError {
  message: string;
  requestId: string;
}

/** 概览仅包含白名单摘要，单项失败不能被零计数替代。 */
export interface ConfigurationOverviewDocument {
  readAt: string;
  entries: Array<{ key: string; summary?: string; needsConfiguration?: boolean; error?: { message: string; requestId: string } }>;
}
