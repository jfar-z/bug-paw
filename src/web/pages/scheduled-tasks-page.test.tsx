import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasksPage } from "./scheduled-tasks-page";

afterEach(() => vi.unstubAllGlobals());

describe("ScheduledTasksPage", () => {
  it("使用 IANA 时区默认值并通过应用内菜单选择现有会话", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/agents") return json({ agents: [agent()] });
      if (url === "/api/v1/agents/agent-1/scheduled-tasks") return json({ tasks: [] });
      if (url === "/api/v1/sessions?agentId=agent-1") return json({ sessions: [session()] });
      if (url === "/api/v1/scheduled-tasks/timezones") return json({ serverTimeZone: "Etc/UTC", timezones: ["Asia/Shanghai", "Etc/UTC"] });
      return json({});
    }));

    render(<ScheduledTasksPage />);

    fireEvent.click(await screen.findByRole("button", { name: "新建任务" }));

    expect(await screen.findByRole("combobox", { name: "时区" })).toHaveValue("Etc/UTC");
    fireEvent.click(screen.getByRole("radio", { name: "现有会话" }));
    expect(screen.queryByRole("combobox", { name: "选择会话" })).not.toBeInTheDocument();

    const trigger = screen.getByRole("button", { name: "选择现有会话" });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "可用会话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: /日报/u }));

    expect(trigger).toHaveTextContent("日报");
    expect(screen.queryByRole("listbox", { name: "可用会话" })).not.toBeInTheDocument();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}

function agent() {
  return {
    profile: {
      id: "agent-1",
      name: "测试 Agent",
      cwd: "/data/workspace/agents/agent-1",
      status: "active",
      description: "",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: [],
      avatar: { kind: "initial", value: "测" },
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
      version: 1,
    },
    revision: "r1",
  };
}

function session() {
  return {
    id: "session-1",
    name: "日报",
    firstMessage: "生成日报",
    modified: "2026-08-07T00:00:00.000Z",
    messageCount: 1,
  };
}
