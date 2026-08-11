import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

  it("原目标会话已删除时强化提示并禁止直接运行或启用", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/v1/agents") return json({ agents: [agent()] });
      if (url === "/api/v1/agents/agent-1/scheduled-tasks") return json({ tasks: [deletedTargetTask()] });
      if (url === "/api/v1/sessions?agentId=agent-1") return json({ sessions: [session()] });
      if (url === "/api/v1/scheduled-tasks/timezones") return json({ serverTimeZone: "Etc/UTC", timezones: ["Etc/UTC"] });
      return json({});
    }));

    render(<ScheduledTasksPage />);

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveClass("scheduled-task-target-missing");
    expect(warning).toHaveTextContent("原目标会话“已删除的日报会话”已删除");
    expect(screen.getByRole("button", { name: "立即执行" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "编辑 日报任务" }));
    expect(screen.getByRole("checkbox", { name: "启用任务" })).toBeDisabled();
    expect(screen.getByText(/重新选择目标后才能启用/)).toBeInTheDocument();
  });

  it("重新选择目标后允许启用并保存任务", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/agents") return json({ agents: [agent()] });
      if (url === "/api/v1/agents/agent-1/scheduled-tasks") return json({ tasks: [deletedTargetTask()] });
      if (url === "/api/v1/sessions?agentId=agent-1") return json({ sessions: [session()] });
      if (url === "/api/v1/scheduled-tasks/timezones") return json({ serverTimeZone: "Etc/UTC", timezones: ["Etc/UTC"] });
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduledTasksPage />);
    fireEvent.click(await screen.findByRole("button", { name: "编辑 日报任务" }));

    const enabled = screen.getByRole("checkbox", { name: "启用任务" });
    fireEvent.click(screen.getByRole("radio", { name: "每次新建会话" }));
    expect(enabled).toBeEnabled();
    fireEvent.click(enabled);
    fireEvent.click(screen.getByRole("button", { name: "保存任务" }));

    await waitFor(() => {
      const update = fetchMock.mock.calls.find(([url, init]) => url === "/api/v1/scheduled-tasks/task-1" && init?.method === "PATCH");
      expect(update).toBeDefined();
      expect(JSON.parse(String(update?.[1]?.body))).toMatchObject({
        enabled: true,
        target: { type: "new_session", archiveAfterCompletion: false },
      });
    });
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

function deletedTargetTask() {
  return {
    id: "task-1",
    agentId: "agent-1",
    name: "日报任务",
    prompt: "生成日报",
    enabled: false,
    schedule: { type: "cron", expression: "0 9 * * *", timezone: "Etc/UTC" },
    target: { type: "deleted_session", sessionId: "deleted-session", sessionName: "已删除的日报会话" },
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
  };
}
