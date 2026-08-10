// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { ScheduledTask } from "../../shared/scheduled-task-contracts";
import { createScheduledTasksTool } from "./scheduled-task-tool";

const ownTask: ScheduledTask = {
  id: "task-own",
  agentId: "writer",
  name: "日报",
  prompt: "整理日报",
  enabled: true,
  schedule: { type: "interval", unit: "hour", value: 1 },
  target: { type: "new_session", archiveAfterCompletion: false },
  createdAt: "2026-08-07T00:00:00.000Z",
  updatedAt: "2026-08-07T00:00:00.000Z",
};

describe("定时任务 Pi 工具", () => {
  it("创建任务时始终使用当前 Agent 身份", async () => {
    const create = vi.fn(async (input) => ({ ...ownTask, ...input }));
    const tool = createScheduledTasksTool("writer", { list: async () => [], create, update: async () => undefined, remove: async () => undefined });
    const result = await tool.execute("tool-call", {
      action: "create", name: "日报", prompt: "整理日报", enabled: true,
      schedule: { type: "interval", unit: "hour", value: 1 },
      target: { type: "new_session", archiveAfterCompletion: false },
    }, undefined, undefined, {} as never);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ agentId: "writer", name: "日报" }));
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("拒绝修改不属于当前 Agent 的任务", async () => {
    const update = vi.fn(async () => ownTask);
    const tool = createScheduledTasksTool("writer", { list: async () => [], create: async () => ownTask, update, remove: async () => undefined });
    const result = await tool.execute("tool-call", { action: "update", taskId: "other", name: "不应修改" }, undefined, undefined, {} as never);
    expect(update).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({ type: "text", text: "找不到当前 Agent 的定时任务。" });
  });
});
