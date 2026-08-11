import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ActivityBlock } from "../activity-groups";
import { ActivityGroup } from "./activity-group";

const runningWrite: ActivityBlock = {
  id: "tool-1",
  type: "tool",
  callId: "call-1",
  name: "write",
  args: { path: "src/app.ts" },
  status: "running",
};

function ControlledGroup({ blocks, trailing = true, streaming = true }: {
  blocks: ActivityBlock[];
  trailing?: boolean;
  streaming?: boolean;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  return <ActivityGroup
    id="activity-tool-1-tool-1"
    blocks={blocks}
    trailing={trailing}
    turnStreaming={streaming}
    expandedOverride={expanded}
    onExpandedChange={setExpanded}
  />;
}

describe("ActivityGroup", () => {
  it("运行中的尾部活动段默认展开，完成并离开尾部后自动收起", () => {
    const { rerender } = render(<ControlledGroup blocks={[runningWrite]} />);

    expect(screen.getByRole("button", { name: "收起活动段：正在写入 src/app.ts" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("write")).toBeInTheDocument();

    rerender(<ControlledGroup blocks={[{ ...runningWrite, status: "completed" }]} trailing={false} streaming />);

    expect(screen.getByRole("button", { name: "展开活动段：已完成 1 项活动" })).toHaveAttribute("aria-expanded", "false");
  });

  it("用户手动选择优先于后续自动状态", () => {
    const { rerender } = render(<ControlledGroup blocks={[runningWrite]} />);
    fireEvent.click(screen.getByRole("button", { name: "收起活动段：正在写入 src/app.ts" }));

    rerender(<ControlledGroup blocks={[{ ...runningWrite, status: "completed" }]} trailing={false} streaming={false} />);

    expect(screen.getByRole("button", { name: "展开活动段：已完成 1 项活动" })).toHaveAttribute("aria-expanded", "false");
  });

  it("错误活动段默认展开并明确显示失败数量", () => {
    render(<ControlledGroup blocks={[{ ...runningWrite, status: "error" }]} trailing={false} streaming={false} />);

    expect(screen.getByRole("button", { name: "收起活动段：1 项活动 · 1 项失败" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("write 执行失败 · src/app.ts")).toBeInTheDocument();
  });

  it("段控制向父级报告用户选择", () => {
    const onExpandedChange = vi.fn();
    render(<ActivityGroup
      id="activity-tool-1-tool-1"
      blocks={[runningWrite]}
      trailing
      turnStreaming
      onExpandedChange={onExpandedChange}
    />);

    fireEvent.click(screen.getByRole("button", { name: "收起活动段：正在写入 src/app.ts" }));
    expect(onExpandedChange).toHaveBeenCalledWith(false);
  });
});
