// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { nextRunAt, serverTimeZone, timeZoneOptions, validateSchedule } from "./schedule";

describe("定时任务调度计算", () => {
  it("按 Cron 时区计算下一次执行时间", () => {
    expect(nextRunAt({ type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" }, new Date("2026-08-07T00:00:00.000Z")))
      .toBe("2026-08-07T01:00:00.000Z");
  });

  it("拒绝未知时区和非正间隔", () => {
    expect(() => validateSchedule({ type: "interval", unit: "minute", value: 0 })).toThrow("间隔");
    expect(() => validateSchedule({ type: "cron", expression: "* * * * *", timezone: "Mars/Olympus" })).toThrow("时区");
  });

  it("将 UTC 默认值规范为 IANA 区域标识", () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(() => ({
      resolvedOptions: () => ({ timeZone: "UTC" }),
    } as Intl.DateTimeFormat));

    try {
      expect(serverTimeZone()).toBe("Etc/UTC");
      expect(timeZoneOptions()).toContain("Etc/UTC");
      expect(timeZoneOptions()).not.toContain("UTC");
    } finally {
      formatter.mockRestore();
    }
  });

  it("一次性任务只返回尚未到达的指定执行时间", () => {
    const schedule = { type: "once" as const, runAt: "2026-08-08T09:00:00.000Z" };
    expect(nextRunAt(schedule, new Date("2026-08-07T00:00:00.000Z"))).toBe("2026-08-08T09:00:00.000Z");
    expect(() => nextRunAt(schedule, new Date("2026-08-08T09:00:00.000Z"))).toThrow("一次性");
  });
});
