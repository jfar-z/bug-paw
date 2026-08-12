import { describe, expect, it } from "vitest";

import { resolveBrowserCapabilities } from "./browser-capabilities";

/** 浏览器工具同时受部署、全局开关和 Agent 白名单约束。 */
describe("浏览器有效能力", () => {
  it("只公开已授权且可部署的工具", () => {
    expect(resolveBrowserCapabilities({
      allowedTools: ["browser_open", "browser_snapshot", "browser_input"],
      enabled: true,
      deploymentAvailable: true,
    }).toolNames).toEqual(["browser_open", "browser_snapshot", "browser_input"]);
  });

  it("能力关闭时不公开任何浏览器工具", () => {
    expect(resolveBrowserCapabilities({
      allowedTools: ["browser_open"],
      enabled: false,
      deploymentAvailable: true,
    }).toolNames).toEqual([]);
  });
});
