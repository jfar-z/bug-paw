import { describe, expect, it } from "vitest";
import { DEFAULT_AIGC_AGENT_LIMITS, readAigcAgentLimits } from "./aigc-agent-limits";

describe("AIGC Agent 限流环境配置", () => {
  it("未配置时使用新的默认值", () => {
    expect(readAigcAgentLimits({})).toEqual(DEFAULT_AIGC_AGENT_LIMITS);
  });

  it("读取四个环境变量并转换查询间隔单位", () => {
    expect(readAigcAgentLimits({
      BUG_PAW_AIGC_AGENT_MAX_ACTIVE_TASKS: "30",
      BUG_PAW_AIGC_AGENT_MAX_ACTIVE_TASKS_PER_AGENT: "6",
      BUG_PAW_AIGC_AGENT_MAX_HOURLY_TASKS_PER_AGENT: "300",
      BUG_PAW_AIGC_AGENT_QUERY_INTERVAL_SECONDS: "3",
    })).toEqual({
      maxActiveTasks: 30,
      maxActiveTasksPerAgent: 6,
      maxHourlyTasksPerAgent: 300,
      queryIntervalMs: 3_000,
    });
  });

  it.each(["0", "-1", "1.5", "abc", " 2"])("拒绝非法正整数 %s", (value) => {
    expect(() => readAigcAgentLimits({ BUG_PAW_AIGC_AGENT_MAX_ACTIVE_TASKS: value })).toThrow(TypeError);
  });
});
