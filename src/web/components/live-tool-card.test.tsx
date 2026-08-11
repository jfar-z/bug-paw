import { fireEvent, render, screen, within } from "@testing-library/react";
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

    expect(screen.getByText("执行命令")).toBeInTheDocument();
    expect(screen.getByText("已完成")).toBeInTheDocument();
    expect(screen.getByText("入参")).toBeInTheDocument();
    expect(screen.getByText("入参").closest(".collapsible-region")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));

    expect(screen.getByText("入参")).toBeInTheDocument();
    expect(screen.getByText("结果")).toBeInTheDocument();
    expect(screen.getByText(/"cmd": "pwd"/)).toBeInTheDocument();
    expect(screen.getByText("/data/workspace")).toBeInTheDocument();
    expect(screen.getByText("入参").closest(".collapsible-region")).toHaveAttribute("aria-hidden", "false");
  });

  it.each([
    ["preparing", "组织命令", "准备中"],
    ["running", "执行命令", "执行中"],
    ["completed", "执行命令", "已完成"],
    ["cancelled", "执行命令", "未执行"],
    ["error", "执行命令", "失败"],
  ] as const)("展示 %s 状态", (status, action, state) => {
    const { container } = render(<LiveToolCard tool={{ ...completedTool, status }} />);

    expect(screen.getByText(action)).toBeInTheDocument();
    const statusElement = container.querySelector(".live-tool-card__status");
    expect(statusElement).not.toBeNull();
    expect(within(statusElement as HTMLElement).getByText(state)).toBeInTheDocument();
    expect(statusElement).not.toHaveTextContent("bash");
    expect(container.firstElementChild).toHaveClass(`is-${status}`);
  });

  it("根据写入工具阶段展示准确动作", () => {
    const { rerender } = render(
      <LiveToolCard tool={{ ...completedTool, name: "write", args: { path: "src/app.ts" }, status: "preparing" }} />,
    );

    expect(screen.getByText("编写 src/app.ts")).toBeInTheDocument();

    rerender(<LiveToolCard tool={{ ...completedTool, name: "write", args: { path: "src/app.ts" }, status: "running" }} />);
    expect(screen.getByText("写入 src/app.ts")).toBeInTheDocument();
  });

  it("为动作和状态提供稳定的排版连接类", () => {
    const { container } = render(<LiveToolCard tool={completedTool} />);

    expect(screen.getByText("执行命令")).toHaveClass("activity-item__action");
    expect(container.querySelector(".live-tool-card__status svg")).toHaveAttribute("width", "14");
  });

  it("执行中展开时显示最新增量结果", () => {
    render(<LiveToolCard tool={{ ...completedTool, result: undefined, partialResult: "已读取 12 行", status: "running" }} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));

    expect(screen.getByText("已读取 12 行")).toBeInTheDocument();
  });

  it.each([
    ["空对象", {}],
    ["空数组", []],
    ["空白字符串", "   "],
  ])("%s 不生成空详情", (_label, details) => {
    render(<LiveToolCard tool={{ ...completedTool, details }} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));

    expect(screen.queryByText("详情")).not.toBeInTheDocument();
  });

  it.each([
    ["数字零", 0],
    ["布尔假值", false],
  ])("%s 作为有效详情展示", (_label, details) => {
    render(<LiveToolCard tool={{ ...completedTool, details }} />);
    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));

    expect(screen.getByText("详情")).toBeInTheDocument();
  });
});
