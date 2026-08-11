/** 经过安全整理、允许进入全局错误提示的数据。 */
export interface ErrorToastInput {
  operation: string;
  title: string;
  summary: string;
  code?: string;
  status?: number;
  requestId?: string;
  safeDetail?: string;
  durationMs?: number;
}

/** Toast 队列交给视图渲染的稳定状态。 */
export interface ErrorToastItem extends ErrorToastInput {
  id: string;
  durationMs: number;
  remainingMs: number;
  expanded: boolean;
  paused: boolean;
}

/** 业务层推送和清理全局错误提示的最小接口。 */
export interface ErrorToastController {
  push(input: ErrorToastInput): string;
  clear(): void;
}
