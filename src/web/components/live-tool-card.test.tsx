import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ToolBlock } from "../conversation-timeline";
import { LiveToolCard } from "./live-tool-card";

const completedTool: ToolBlock = {
  id: "tool-1",
  type: "tool",
  callId: "call-1",
  name: "bash",
  args: { cmd: "pwd" },
  result: "/data/workspace",
  status: "completed",
};

describe("LiveToolCard", () => {
  it("默认折叠并在点击后显示格式化入参与结果", () => {
    render(<LiveToolCard tool={completedTool} />);

    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.queryByText("入参")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));

    expect(screen.getByText("入参")).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
    expect(screen.getByText(/"cmd": "pwd"/)).toBeInTheDocument();
    expect(screen.getByText("/data/workspace")).toBeInTheDocument();
  });

  it.each([
    ["running", "执行中"],
    ["completed", "已完成"],
    ["error", "执行失败"],
  ] as const)("展示 %s 状态", (status, label) => {
    const { container } = render(<LiveToolCard tool={{ ...completedTool, status }} />);

    expect(screen.getByText(label)).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass(`is-${status}`);
  });

  it("执行中展开时显示最新增量结果", () => {
    render(<LiveToolCard tool={{ ...completedTool, result: undefined, partialResult: "已读取 12 行", status: "running" }} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));

    expect(screen.getByText("已读取 12 行")).toBeInTheDocument();
  });
});
