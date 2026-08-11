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
