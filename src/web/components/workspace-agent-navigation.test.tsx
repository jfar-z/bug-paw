import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { WorkspaceAgentNavigation } from "./workspace-agent-navigation";

function agent(id: string, name: string, avatar: string): AgentProfileDocument {
  return {
    profile: {
      version: 1,
      id,
      name,
      description: "",
      status: "active",
      cwd: `/data/workspace/agents/${id}`,
      avatar: { kind: "initial", value: avatar },
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: [],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    },
    revision: "1",
  };
}

describe("WorkspaceAgentNavigation", () => {
  it("展示 Agent 列表并切换当前工作空间", () => {
    const onSelect = vi.fn();
    render(<WorkspaceAgentNavigation agents={[
      agent("agent-a", "写作助手", "写"),
      agent("agent-b", "研究助手", "研"),
    ]} selectedAgentId="agent-a" mobileOpen={false} onSelect={onSelect} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "选择 Agent 研究助手" }));
    expect(onSelect).toHaveBeenCalledWith("agent-b");
  });
});
