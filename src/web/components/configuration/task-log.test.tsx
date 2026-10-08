import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { TaskLog } from "./task-log";

/** 可控 SSE 源验证资源任务必须确认成功才产生生效提示。 */
class TestEventSource {
  static latest: TestEventSource;
  onmessage?: (event: { data: string }) => void;
  onerror?: () => void;
  close = vi.fn();
  constructor() { TestEventSource.latest = this; }
  send(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
function show(onCompleted: () => void) {
  vi.stubGlobal("EventSource", TestEventSource);
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><TaskLog taskId="fictional-task" onCompleted={onCompleted} /></ApiTaskProvider></ErrorToastProvider>);
  return TestEventSource.latest;
}
afterEach(() => vi.unstubAllGlobals());
describe("资源任务生效边界", () => {
  it("开始或日志不标记保存，完成事件只通知一次", () => {
    const completed = vi.fn(); const stream = show(completed);
    act(() => stream.send({ type: "started", label: "安装示例" }));
    expect(completed).not.toHaveBeenCalled();
    act(() => { stream.send({ type: "completed" }); stream.send({ type: "completed" }); });
    expect(completed).toHaveBeenCalledTimes(1);
    expect(stream.close).toHaveBeenCalled();
  });
  it("失败和断流不会标记已保存，且故障直接呈现", async () => {
    const completed = vi.fn(); const stream = show(completed);
    act(() => stream.send({ type: "failed", code: "RESOURCE_TASK_FAILED", message: "示例扩展下载中断" }));
    expect(completed).not.toHaveBeenCalled();
    expect(await screen.findAllByText(/示例扩展下载中断/)).not.toHaveLength(0);
  });
});
