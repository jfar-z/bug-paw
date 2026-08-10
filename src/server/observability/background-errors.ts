import { toSafeErrorDetails } from "../core/errors";

export interface BackgroundErrorRecord {
  code: string;
  occurredAt: string;
  details?: Record<string, unknown>;
}

/** 有界保存后台失败摘要，不保留异常堆栈、消息正文或凭据。 */
export class BackgroundErrorRegistry {
  private readonly records: BackgroundErrorRecord[] = [];

  constructor(private readonly maxEntries = 100) {}

  record(code: string, details?: Record<string, unknown>): void {
    const safeDetails = details ? toSafeErrorDetails(details) : undefined;
    this.records.push({
      code,
      occurredAt: new Date().toISOString(),
      ...(safeDetails && Object.keys(safeDetails).length > 0 ? { details: safeDetails } : {}),
    });
    if (this.records.length > this.maxEntries) this.records.splice(0, this.records.length - this.maxEntries);
  }

  summary(): { total: number; latestCode?: string; latestAt?: string } {
    const latest = this.records.at(-1);
    return {
      total: this.records.length,
      ...(latest ? { latestCode: latest.code, latestAt: latest.occurredAt } : {}),
    };
  }
}
