// @vitest-environment node
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { AigcTaskRecord } from "../../shared/aigc-contracts";
import { newWorkflowNode } from "../../shared/workflow-contracts";
import { WorkflowNodeExecutor } from "./workflow-executor";
import type { WorkflowExecutionContext } from "./workflow-service";

// 跳过真实轮询等待，仍检查取消信号，确保重复进度不会阻断轮询或取消。
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
  setTimeout: vi.fn(async (_ms, _value, options) => {
    options?.signal?.throwIfAborted();
  }),
}));

/** 使用合成 ComfyUI 任务验证真实执行器，不创建上游任务或读取生产数据。 */
function fixture() {
  const task: AigcTaskRecord = {
    id: "task",
    interfaceId: "interface",
    interfaceName: "测试接口",
    channelId: "channel",
    status: "succeeded",
    inputs: {},
    assets: [],
    createdAt: "2026-10-30T00:00:00.000Z",
    updatedAt: "2026-10-30T00:00:00.000Z",
  };
  const get = vi.fn(async () => task);
  const cancel = vi.fn(async () => ({ upstreamCancellation: "confirmed" }));
  const executor = new WorkflowNodeExecutor({
    interfaces: {
      get: async () => ({
        id: "interface",
        enabled: true,
        protocol: "comfyui",
        config: { workflowId: "workflow" },
      }),
    },
    aigcWorkflows: {
      get: async () => ({
        workflow: { nodes: [], edges: [], inputMappings: [], outputMappings: [] },
      }),
    },
    aigcTasks: { createRun: async () => task, get, cancel },
  } as never);
  const node = newWorkflowNode("aigc", "aigc");
  node.config.interfaceId = "interface";
  const controller = new AbortController();
  const progress = vi.fn(async (_message: string) => {});
  const ctx: WorkflowExecutionContext = {
    node,
    run: { id: "run", nodes: [{ nodeId: node.id, events: [] }] } as never,
    signal: controller.signal,
    progress,
  };
  return { task, get, cancel, executor, ctx, controller, progress };
}

describe("工作流 AIGC 进度事件去重", () => {
  it("忽略时间变化，保留首次、阶段、进度值及总量变化和再次出现的状态", async () => {
    const f = fixture();
    const snapshots: Partial<AigcTaskRecord>[] = [
      { status: "queued" },
      { status: "queued" },
      { status: "running" },
      { status: "running" },
      ...[0, 0, 1, 1, 2, 1].map((progressValue) => ({
        status: "running" as const,
        execution: {
          phase: "running" as const,
          progressValue,
          progressMax: 5,
          updatedAt: f.task.updatedAt,
        },
      })),
      {
        status: "running",
        execution: {
          phase: "running",
          progressValue: 1,
          progressMax: 10,
          updatedAt: f.task.updatedAt,
        },
      },
      {
        status: "running",
        execution: { phase: "downloading", updatedAt: f.task.updatedAt },
      },
      {
        status: "running",
        execution: { phase: "downloading", updatedAt: f.task.updatedAt },
      },
    ];
    snapshots.forEach((snapshot, index) => {
      const updatedAt = new Date(
        Date.parse(f.task.updatedAt) + index * 1500,
      ).toISOString();
      f.get.mockResolvedValueOnce({
        ...f.task,
        ...snapshot,
        updatedAt,
        execution: snapshot.execution && { ...snapshot.execution, updatedAt },
      });
    });
    vi.mocked(delay).mockClear();
    await expect(f.executor.execute(f.ctx, {})).resolves.toBeDefined();
    expect(f.progress.mock.calls.map(([message]) => message)).toEqual([
      "AIGC task · queued",
      "AIGC task · running",
      "AIGC task · running · 0/5",
      "AIGC task · running · 1/5",
      "AIGC task · running · 2/5",
      "AIGC task · running · 1/5",
      "AIGC task · running · 1/10",
      "AIGC task · downloading",
    ]);
    expect(f.get).toHaveBeenCalledTimes(snapshots.length + 1);
    expect(delay).toHaveBeenCalledTimes(snapshots.length);
    expect(f.cancel).not.toHaveBeenCalled();
  });

  it("每次执行独立去重，相同首条进度不会被上一次执行吞掉", async () => {
    const f = fixture();
    for (let run = 0; run < 2; run++) {
      f.get.mockResolvedValueOnce({ ...f.task, status: "running" });
      f.get.mockResolvedValueOnce({ ...f.task, status: "running" });
      await f.executor.execute(f.ctx, {});
    }
    expect(f.progress.mock.calls).toEqual([
      ["AIGC task · running"],
      ["AIGC task · running"],
    ]);
  });

  it("重复进度期间取消仍传递上游并记录取消事件", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ ...f.task, status: "running" });
    f.get.mockImplementationOnce(async () => {
      f.controller.abort();
      return { ...f.task, status: "running" };
    });
    await expect(f.executor.execute(f.ctx, {})).rejects.toThrow();
    expect(f.progress).toHaveBeenCalledTimes(1);
    expect(f.cancel).toHaveBeenCalledWith("task");
    expect(f.ctx.run.nodes[0].events).toEqual([
      { at: expect.any(String), message: "AIGC task 上游取消：confirmed" },
    ]);
  });

  it("重复进度后失败仍向调用方呈现上游错误", async () => {
    const f = fixture();
    f.get.mockResolvedValueOnce({ ...f.task, status: "running" });
    f.get.mockResolvedValueOnce({ ...f.task, status: "running" });
    f.get.mockResolvedValueOnce({
      ...f.task,
      status: "failed",
      error: { code: "REQUEST_FAILED", message: "ComfyUI 执行节点失败" },
    });
    await expect(f.executor.execute(f.ctx, {})).rejects.toThrow(
      "ComfyUI 执行节点失败",
    );
    expect(f.progress).toHaveBeenCalledTimes(1);
  });
});
