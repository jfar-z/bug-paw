import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ToolBlock } from "../conversation-timeline";
import { LiveToolCard } from "./live-tool-card";

describe("LiveToolCard", () => {
  it("已完成的 read 工具可从独立按钮打开受支持文件", () => {
    const onLinkActivate = vi.fn(() => true);
    render(<LiveToolCard tool={readTool("notes/readme.md")} onLinkActivate={onLinkActivate} />);

    fireEvent.click(screen.getByRole("button", { name: "查看 notes/readme.md 文件内容" }));

    expect(onLinkActivate).toHaveBeenCalledWith("notes/readme.md");
    expect(screen.getByRole("button", { name: "展开 read 工具详情" })).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    ["不支持的文件类型", readTool("archives/source.zip")],
    ["工作区外的绝对路径", readTool("/opt/private/secret.txt")],
    ["尚未完成的读取", readTool("notes/readme.md", "running")],
    ["非 read 工具", { ...readTool("notes/readme.md"), name: "write" }],
  ])("%s 不展示文件预览按钮", (_label, tool) => {
    render(<LiveToolCard tool={tool} onLinkActivate={vi.fn(() => true)} />);

    expect(screen.queryByRole("button", { name: /查看 .* 文件内容/ })).not.toBeInTheDocument();
  });
});

function readTool(path: string, status: ToolBlock["status"] = "completed"): ToolBlock {
  return {
    id: `tool-${path}`,
    type: "tool",
    callId: `call-${path}`,
    name: "read",
    args: { path },
    result: "file content",
    status,
  };
}
