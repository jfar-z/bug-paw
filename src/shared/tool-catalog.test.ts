import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_TOOL_NAMES,
  STARTUP_ENFORCED_SYSTEM_TOOL_NAMES,
  SYSTEM_TOOL_CATALOG,
  SYSTEM_TOOL_NAMES,
} from "./tool-catalog";

describe("会话文本系统工具目录", () => {
  it("为新旧 Agent 提供低风险的列表、搜索与阅读权限", () => {
    expect(SYSTEM_TOOL_CATALOG).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "session_list", source: "system", highRisk: false }),
      expect.objectContaining({ name: "session_search", source: "system", highRisk: false }),
      expect.objectContaining({ name: "session_read", source: "system", highRisk: false }),
    ]));
    expect(DEFAULT_AGENT_TOOL_NAMES).toEqual(expect.arrayContaining(["session_list", "session_search", "session_read"]));
    expect(SYSTEM_TOOL_NAMES).toEqual(expect.arrayContaining(["session_list", "session_search", "session_read"]));
  });

  it("默认启用 ask_user，但不在启动期强制恢复管理员已移除的权限", () => {
    expect(SYSTEM_TOOL_CATALOG).toContainEqual({
      name: "ask_user",
      description: "向用户提交结构化问题并等待回答",
      source: "system",
      highRisk: false,
    });
    expect(DEFAULT_AGENT_TOOL_NAMES).toContain("ask_user");
    expect(SYSTEM_TOOL_NAMES).toContain("ask_user");
    expect(STARTUP_ENFORCED_SYSTEM_TOOL_NAMES).not.toContain("ask_user");
  });
});
