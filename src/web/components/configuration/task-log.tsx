import { useEffect, useState } from "react";

interface TaskEvent { type: "started" | "log" | "completed" | "failed"; line?: string; message?: string; label?: string }

/**
 * 订阅配置长任务 SSE，并以顺序日志显示最终状态。
 */
export function TaskLog({ taskId }: { taskId: string }) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  useEffect(() => {
    const stream = new EventSource(`/api/v1/configuration/tasks/${encodeURIComponent(taskId)}/events`);
    stream.onmessage = (message) => { const event = JSON.parse(message.data) as TaskEvent; setEvents((current) => [...current, event]); if (event.type === "completed" || event.type === "failed") stream.close(); };
    stream.onerror = () => stream.close(); return () => stream.close();
  }, [taskId]);
  return <ol className="task-log" aria-label="任务日志">{events.map((event, index) => <li key={index} data-status={event.type}>{event.line ?? event.message ?? event.label ?? (event.type === "completed" ? "任务完成" : event.type)}</li>)}</ol>;
}
