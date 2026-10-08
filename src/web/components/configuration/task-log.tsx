import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../api";
import { useApiTask } from "../../api-task-provider";

interface TaskEvent { type: "started" | "log" | "completed" | "failed"; line?: string; message?: string; label?: string; code?: string }

/** 订阅配置任务，只有确认 completed 才通知配置已保存，失败或断流直接展示。 */
export function TaskLog({ taskId, onCompleted }: { taskId: string; onCompleted?: () => void }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const completion = useRef(onCompleted);
  completion.current = onCompleted;
  const { runApiTask } = useApiTask();
  useEffect(() => {
    setEvents([]);
    let terminal = false;
    const stream = new EventSource(`/api/v1/configuration/tasks/${encodeURIComponent(taskId)}/events`);
    const report = (code: string, message: string) => {
      terminal = true;
      stream.close();
      setEvents((current) => [...current, { type: "failed", code, message }]);
      void runApiTask(async () => { throw new ApiClientError(code, message, 500); }, { operation: "执行配置资源任务" });
    };
    stream.onmessage = (message) => {
      if (terminal) return;
      let event: TaskEvent;
      try {
        event = JSON.parse(message.data) as TaskEvent;
        if (!event || !["started", "log", "completed", "failed"].includes(event.type)) throw new Error("资源任务事件结构无效");
      } catch { report("RESOURCE_TASK_EVENT_INVALID", "配置资源任务返回了无法解析的事件，无法确认任务是否完成。"); return; }
      if (event.type === "failed") { report(event.code ?? "RESOURCE_TASK_FAILED", event.message ?? "配置资源任务执行器返回失败事件，但未提供诊断消息。"); return; }
      setEvents((current) => [...current, event]);
      if (event.type === "completed") { terminal = true; stream.close(); completion.current?.(); }
    };
    stream.onerror = () => { if (!terminal) report("RESOURCE_TASK_STREAM_INTERRUPTED", "配置资源任务事件连接中断，尚未收到完成结果。请检查资源目录和服务状态。"); };
    return () => { terminal = true; stream.close(); };
  }, [taskId, runApiTask]);
  return <ol className="task-log" aria-label="任务日志">{events.map((event, index) => <li key={index} data-status={event.type}>{event.line ?? event.message ?? event.label ?? (event.type === "completed" ? "任务完成" : event.type)}</li>)}</ol>;
}
