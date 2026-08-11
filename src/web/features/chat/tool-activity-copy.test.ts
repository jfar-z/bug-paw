import { describe, expect, it } from "vitest";

import type { ToolBlock } from "../../conversation-timeline";
import { toolActivityCopy, toolTargetPath } from "./tool-activity-copy";

function tool(name: string, status: ToolBlock["status"], args?: unknown): ToolBlock {
  return { id: "tool-1", type: "tool", callId: "call-1", name, args, status };
}

describe("工具活动文案", () => {
  it("区分文件内容编写与实际写入阶段", () => {
    expect(toolActivityCopy(tool("write", "preparing"))).toBe("正在编写文件内容");
    expect(toolActivityCopy(tool("write", "preparing", { path: "src/app.ts" }))).toBe("正在编写 src/app.ts");
    expect(toolActivityCopy(tool("write", "running", { path: "src/app.ts" }))).toBe("正在写入 src/app.ts");
  });

  it("为编辑、命令、读取和自定义工具生成阶段准确文案", () => {
    expect(toolActivityCopy(tool("edit", "preparing", { path: "src/app.ts" }))).toBe("正在拟定对 src/app.ts 的修改");
    expect(toolActivityCopy(tool("edit", "running", { path: "src/app.ts" }))).toBe("正在应用对 src/app.ts 的修改");
    expect(toolActivityCopy(tool("bash", "preparing"))).toBe("正在组织命令");
    expect(toolActivityCopy(tool("read", "running", { file_path: "README.md" }))).toBe("正在读取 README.md");
    expect(toolActivityCopy(tool("custom_tool", "preparing"))).toBe("正在生成 custom_tool 的调用参数");
  });

  it("完成、取消与失败文案不暗示尚未发生的副作用", () => {
    expect(toolActivityCopy(tool("write", "completed", { path: "src/app.ts" }))).toBe("write 已完成 · src/app.ts");
    expect(toolActivityCopy(tool("write", "cancelled", { path: "src/app.ts" }))).toBe("write 未执行 · src/app.ts");
    expect(toolActivityCopy(tool("write", "error", { path: "src/app.ts" }))).toBe("write 执行失败 · src/app.ts");
  });

  it("只从可靠字符串字段读取目标路径", () => {
    expect(toolTargetPath({ path: "src/app.ts" })).toBe("src/app.ts");
    expect(toolTargetPath({ file_path: "README.md" })).toBe("README.md");
    expect(toolTargetPath({ path: "" })).toBeUndefined();
    expect(toolTargetPath({ path: 42 })).toBeUndefined();
    expect(toolTargetPath("src/app.ts")).toBeUndefined();
  });
});
