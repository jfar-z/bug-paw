import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_TOOL_NAMES,
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
});
