import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, LoaderCircle, TerminalSquare } from "lucide-react";
import { useState } from "react";
import { formatToolValue, type ToolBlock } from "../conversation-timeline";

interface LiveToolCardProps {
  tool: ToolBlock;
}

const statusLabels = {
  preparing: "准备中",
  running: "执行中",
  completed: "已完成",
  cancelled: "未执行",
  error: "执行失败",
} as const;

/**
 * 展示可折叠的工具入参、实时输出和最终结果。
 */
export function LiveToolCard({ tool }: LiveToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const statusIcon = tool.status === "running"
    ? <LoaderCircle className="spinner" size={16} aria-hidden="true" />
    : tool.status === "error"
      ? <CircleAlert size={16} aria-hidden="true" />
      : <CheckCircle2 size={16} aria-hidden="true" />;

  return (
    <section className={`live-tool-card is-${tool.status}`}>
      <button
        type="button"
        className="live-tool-card__summary"
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"} ${tool.name} 工具详情`}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <TerminalSquare size={17} aria-hidden="true" />
        <strong>{tool.name}</strong>
        <span className="live-tool-card__status">{statusIcon}{statusLabels[tool.status]}</span>
      </button>

      {expanded && (
        <div className="live-tool-card__details">
          <ToolDetail title="入参" value={tool.args} />
          <ToolDetail title="结果" value={output} />
          {tool.details !== undefined && <ToolDetail title="详情" value={tool.details} />}
        </div>
      )}
    </section>
  );
}

function ToolDetail({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="live-tool-card__detail">
      <h4>{title}</h4>
      <pre><code>{formatToolValue(value)}</code></pre>
    </section>
  );
}
