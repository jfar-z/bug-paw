import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../styles.css";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { LiveChatPage } from "./live-chat-page";

type EventListener = (event: MessageEvent) => void;
const operationLog: string[] = [];

class FakeEventSource {
  static readonly OPEN = 1;
  static instances: FakeEventSource[] = [];
  readonly readyState = FakeEventSource.OPEN;
  readonly listeners = new Map<string, EventListener[]>();
  onerror: (() => void) | null = null;
  private nextEventId = 1;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
    operationLog.push(`sse:${url}`);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {}

  /** 模拟浏览器完成 EventSource 自动重连。 */
  emitOpen() {
    const event = { data: "" } as MessageEvent;
    this.listeners.get("open")?.forEach((listener) => listener(event));
  }

  emit(type: string, payload: unknown) {
    const sessionId = decodeURIComponent(this.url.match(/\/sessions\/([^/]+)\/events/)?.[1] ?? "");
    const original = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const suppliedId = typeof original.id === "number" ? original.id : undefined;
    const id = suppliedId ?? this.nextEventId;
    this.nextEventId = Math.max(this.nextEventId, id + 1);
    const isRunScopedEvent = type !== "snapshot" && type !== "session_renamed";
    const normalized = {
      id,
      type,
      sessionId,
      ...(isRunScopedEvent ? { runId: "run-1" } : {}),
      ...original,
      ...(type === "snapshot" && original.lastEventId === undefined ? { lastEventId: id } : {}),
    };
    const event = { data: JSON.stringify(normalized) } as MessageEvent;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

/** 页面级音频桩保留播放状态，便于验证按钮和导航触发的停止行为。 */
class PageFakeAudio {
  static instances: PageFakeAudio[] = [];
  readonly listeners = new Map<"ended" | "error", Array<() => void>>();
  played = false;
  paused = false;

  constructor(readonly src: string) {
    PageFakeAudio.instances.push(this);
  }

  async play(): Promise<void> {
    this.played = true;
  }

  pause(): void {
    this.paused = true;
  }

  addEventListener(type: "ended" | "error", listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  finish(): void {
    this.listeners.get("ended")?.forEach((listener) => listener());
  }
}

const props = {
  theme: "light" as const,
  onThemeChange: vi.fn(),
  userIdentity: { displayName: "管理员", avatarText: "A" },
  agentIdentity: { displayName: "默认 Agent", avatarText: "π" },
};

/** 使用生产环境一致的异步任务和错误提示上下文渲染聊天页面。 */
function renderLiveChatPage(element: ReactElement) {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>{element}</ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

function mediaQueryResult(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  PageFakeAudio.instances = [];
  operationLog.length = 0;
  window.sessionStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryResult(false)));
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    operationLog.push(`fetch:${init?.method ?? "GET"}:${url}`);
    if (url === "/api/v1/agents") {
      return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, description: "用于测试的 Agent", status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
    }
    if (url === "/api/v1/sessions" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "session-new", agentId: "default", messages: [], lastEventId: 0 }));
    }
    if (url === "/api/v1/sessions?agentId=default") {
      return new Response(JSON.stringify({ sessions: [
        { id: "session-1", firstMessage: "测试", modified: "", messageCount: 0 },
        { id: "session-2", firstMessage: "第二会话", modified: "", messageCount: 2, scheduledTaskCount: 2 },
      ] }));
    }
    if (url === "/api/v1/sessions?agentId=default&archived=true") {
      return new Response(JSON.stringify({ sessions: [{ id: "archived-1", name: "旧会话", firstMessage: "旧问题", modified: "", messageCount: 2 }] }));
    }
    if (url === "/api/v1/models") {
      return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
    }
    if (url === "/api/v1/sessions/bulk/preview" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        action: "archive" | "restore" | "delete";
        target: { mode: "selected"; sessionIds: string[] } | { mode: "all_archived"; agentId: string };
      };
      const sessionIds = body.target.mode === "selected" ? body.target.sessionIds : ["archived-1"];
      return new Response(JSON.stringify({
        ...body,
        sessionCount: sessionIds.length,
        tasks: body.action === "delete" && (sessionIds.includes("session-2") || body.target.mode === "all_archived") ? [
          { id: "task-1", name: "日报", sessionId: "session-2" },
          { id: "task-2", name: "周报", sessionId: "session-2" },
        ] : [],
        fingerprint: "fingerprint-1",
      }));
    }
    if (url === "/api/v1/sessions/bulk" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        action: "archive" | "restore" | "delete";
        target: { mode: "selected"; sessionIds: string[] } | { mode: "all_archived"; agentId: string };
      };
      const sessionCount = body.target.mode === "selected" ? body.target.sessionIds.length : 1;
      return new Response(JSON.stringify({ action: body.action, sessionCount, affectedTaskCount: 2 }));
    }
    if (url === "/api/v1/sessions/session-1") {
      return new Response(JSON.stringify({ id: "session-1", messages: [], lastEventId: 0 }));
    }
    if (url === "/api/v1/sessions/archived-1") {
      return new Response(JSON.stringify({ id: "archived-1", agentId: "default", messages: [], lastEventId: 0 }));
    }
    if (url.endsWith("/edit")) {
      return new Response(JSON.stringify({ snapshot: { id: "session-1", messages: [], lastEventId: 0 }, draft: { text: "编辑后的版本", filePaths: [], missingFilePaths: [], references: [] } }));
    }
    if (url.includes("/branches/") && url.endsWith("/messages")) {
      return new Response(JSON.stringify({
        snapshot: {
          id: "session-1",
          messages: [
            { role: "user", content: "上一条" },
            { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
          ],
          lastEventId: 2,
        },
        run: {
          runId: "run-branch",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-05T08:00:00.000Z",
        },
      }));
    }
    if (url.endsWith("/messages")) {
      const sessionId = url.split("/")[3];
      return new Response(JSON.stringify({
        runId: "run-1",
        sessionId,
        status: "running",
        startedAt: "2026-08-05T08:00:00.000Z",
      }));
    }
    if (url === "/api/v1/agents/default/attachments") {
      return new Response(JSON.stringify({
        files: [{
          path: "attachments/图片.png",
          name: "图片.png",
          mediaType: "image/png",
          size: 5,
          modifiedAt: "2026-08-05T08:00:00.000Z",
        }],
      }));
    }
    if (url.includes("/api/v1/agents/default/files/")) {
      return new Response(null, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "5",
          "Last-Modified": "Wed, 05 Aug 2026 08:00:00 GMT",
        },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
});

describe("LiveChatPage 时间线", () => {
  it("实时连接自动重连成功后撤销中断提示", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => source.onerror?.());
    expect(screen.getByText("实时连接暂时中断，浏览器会自动重连。")).toHaveClass("live-chat-error");

    act(() => source.emitOpen());
    await waitFor(() => expect(screen.queryByText("实时连接暂时中断，浏览器会自动重连。")).not.toBeInTheDocument());
  });

  it("实时连接重连不会覆盖或清除业务错误", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];

    act(() => source.emit("error", { code: "AGENT_EXECUTION_FAILED", message: "Agent 执行失败" }));
    expect(screen.getByText("Agent 执行失败")).toHaveClass("live-chat-error");

    act(() => source.onerror?.());
    expect(screen.getByText("Agent 执行失败")).toHaveClass("live-chat-error");

    act(() => source.emitOpen());
    expect(screen.getByText("Agent 执行失败")).toHaveClass("live-chat-error");
  });

  it("将用户操作区置于气泡外侧，并把版本切换发送到分支导航接口", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "测试" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0].emit("snapshot", {
      messages: [
        {
          role: "user",
          content: "当前版本",
          __piEntryId: "user-current",
          __piBranch: {
            index: 1,
            count: 2,
            previousEntryId: "user-old",
            previousNavigationEntryId: "assistant-old",
          },
        },
        { role: "assistant", content: [{ type: "text", text: "当前回答" }] },
      ],
      lastEventId: 2,
    }));

    const actions = await screen.findByLabelText("用户消息操作");
    expect(actions).toHaveClass("message-actions--separated", "user-message-actions");
    expect(actions.closest(".message-content")).toBeNull();
    expect(actions.closest(".user-message-body")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "切换到上一版本" }));
    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-1/branches/assistant-old/navigate"));
  });

  it("编辑历史消息时标记来源并展示创建分支的输入上下文", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "测试" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0].emit("snapshot", {
      messages: [
        { role: "user", content: "当前版本", __piEntryId: "user-current" },
        { role: "assistant", content: [{ type: "text", text: "当前回答" }] },
      ],
      lastEventId: 2,
    }));

    fireEvent.click(await screen.findByRole("button", { name: "重新编辑消息" }));

    expect(await screen.findByText("正在编辑历史消息")).toBeInTheDocument();
    expect(screen.getByText("发送后将创建新分支，原消息不会改动。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "取消编辑" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建分支并发送" })).toBeInTheDocument();
    expect(screen.queryByText("创建分支并发送")).toBeNull();
    expect(document.querySelector(".message-row.is-editing-source")).not.toBeNull();
  });

  it("编辑历史消息发送后将新消息接在分支快照末尾并退出编辑态", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "测试" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0].emit("snapshot", {
      messages: [
        { role: "user", content: "上一条", __piEntryId: "user-previous" },
        { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
        { role: "user", content: "当前版本", __piEntryId: "user-current" },
        { role: "assistant", content: [{ type: "text", text: "当前回答" }] },
      ],
      lastEventId: 4,
    }));

    const editButtons = await screen.findAllByRole("button", { name: "重新编辑消息" });
    fireEvent.click(editButtons.at(-1)!);
    await screen.findByText("正在编辑历史消息");

    fireEvent.click(screen.getByRole("button", { name: "创建分支并发送" }));
    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-1/branches/user-current/messages"));

    await waitFor(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(".message-row")].map((row) => row.textContent ?? "");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain("上一条");
      expect(rows[1]).toContain("旧回答");
      expect(rows[2]).toContain("编辑后的版本");
    });
    expect(screen.queryByText("正在编辑历史消息")).toBeNull();
    expect(document.querySelector(".message-row.is-editing-source")).toBeNull();
  });

  it("将会话历史与工作台导航拆分为独立入口", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByRole("button", { name: "打开会话历史" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开工作台导航" })).toBeInTheDocument();
  });

  it("刷新会话列表时保留当前聊天且支持移动端下拉触发", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);

    await screen.findByRole("button", { name: "测试" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const initialOpenRequests = vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/sessions/session-1").length;

    fireEvent.click(screen.getByRole("button", { name: "刷新会话列表" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/sessions?agentId=default")).toHaveLength(2));
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/sessions/session-1")).toHaveLength(initialOpenRequests);

    const navigation = screen.getAllByRole("navigation", { name: "会话历史" }).at(-1)!;
    Object.defineProperty(navigation, "scrollTop", { configurable: true, value: 0 });
    fireEvent.touchStart(navigation, { touches: [{ clientY: 12 }] });
    fireEvent.touchMove(navigation, { touches: [{ clientY: 96 }] });
    fireEvent.touchEnd(navigation);

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/sessions?agentId=default")).toHaveLength(3));
    expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/sessions/session-1")).toHaveLength(initialOpenRequests);
  });

  it("收到会话重命名事件后立即更新当前会话列表标题", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "测试" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0].emit("session_renamed", {
      type: "session_renamed",
      name: "分析设计图中的问题",
    }));

    expect(await screen.findByRole("button", { name: "分析设计图中的问题" })).toBeInTheDocument();
  });

  it("刷新后当前会话不存在时打开最新列表的第一个会话", async () => {
    let sessionListRequestCount = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") {
        return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, description: "用于测试的 Agent", status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      }
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
      if (url === "/api/v1/sessions?agentId=default") {
        sessionListRequestCount += 1;
        return new Response(JSON.stringify({ sessions: sessionListRequestCount === 1
          ? [{ id: "session-1", firstMessage: "旧会话", modified: "", messageCount: 0 }]
          : [{ id: "session-2", firstMessage: "刷新后的会话", modified: "", messageCount: 0 }] }));
      }
      if (url === "/api/v1/sessions/session-1" || url === "/api/v1/sessions/session-2") {
        return new Response(JSON.stringify({ id: url.endsWith("session-2") ? "session-2" : "session-1", messages: [], lastEventId: 0 }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "旧会话" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "刷新会话列表" }));

    expect(await screen.findByRole("button", { name: "刷新后的会话" })).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input) === "/api/v1/sessions/session-2")).toBe(true));
    expect(FakeEventSource.instances.at(-1)?.url).toContain("/api/v1/sessions/session-2/events");
  });

  it("将工作台入口渲染为带下拉提示的可点击按钮", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    const trigger = await screen.findByRole("button", { name: "打开工作台导航" });

    expect(trigger).toHaveTextContent("工作台");
    expect(trigger).not.toHaveTextContent("π");
    expect(trigger.querySelector("svg.lucide-chevron-down")).not.toBeNull();
  });

  it("为竖屏工作台和 Agent 选择器提供对等的布局钩子", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);

    const workspaceSwitcher = await screen.findByRole("button", { name: "打开工作台导航" });

    expect(workspaceSwitcher.closest(".chat-header")).toHaveClass("live-chat-header");
    expect(screen.getByRole("button", { name: "切换 Agent 或模型" })).toHaveClass("agent-model-menu__trigger");
  });

  it("在 Agent 选择框右侧提供快捷新建会话按钮", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);

    const quickCreate = await screen.findByRole("button", { name: "新建会话" });

    expect(quickCreate).toHaveClass("chat-new-session-button");
    expect(quickCreate.querySelector("svg.lucide-message-square-plus")).not.toBeNull();

    fireEvent.click(quickCreate);
    expect(await screen.findByRole("heading", { name: "默认 Agent" })).toBeInTheDocument();
    expect(screen.getByText("用于测试的 Agent")).toBeInTheDocument();
    expect(screen.getByLabelText("默认 Agent 头像")).toBeInTheDocument();
  });

  it("触摸长按会话时展开操作菜单且不打开会话", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    const sessionButton = await screen.findByRole("button", { name: "测试" });
    operationLog.length = 0;
    vi.useFakeTimers();

    try {
      fireEvent.pointerDown(sessionButton, { pointerType: "touch" });
      await act(async () => { await vi.advanceTimersByTimeAsync(450); });
      fireEvent.pointerUp(sessionButton, { pointerType: "touch" });
      fireEvent.click(sessionButton);

      expect(screen.getByRole("menu")).toBeInTheDocument();
      expect(operationLog).not.toContain("fetch:GET:/api/v1/sessions/session-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("从会话菜单进入多选并经任务强化确认后批量删除", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: /^第二会话/ });

    fireEvent.click(screen.getByRole("button", { name: "管理会话：第二会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));

    expect(screen.getByRole("checkbox", { name: "选择 第二会话" })).toBeChecked();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "删除已选会话" }));

    const dialog = await screen.findByRole("dialog", { name: "确认删除 1 个会话" });
    expect(dialog.querySelector(".session-bulk-dialog__task-warning.is-destructive")).not.toBeNull();
    expect(screen.getByText(/任务记录会保留并标记原目标已删除/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除会话并停用任务" }));

    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/bulk"));
    const executeCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/sessions/bulk");
    expect(JSON.parse(String(executeCall?.[1]?.body))).toEqual({
      action: "delete",
      target: { mode: "selected", sessionIds: ["session-2"] },
      fingerprint: "fingerprint-1",
    });
    expect(screen.queryByRole("button", { name: /^第二会话/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("通过遮罩或工作台入口关闭侧栏都会取消当前选择", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: /^第二会话/ });
    fireEvent.click(screen.getByRole("button", { name: "打开会话历史" }));
    fireEvent.click(screen.getByRole("button", { name: "管理会话：第二会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    expect(screen.getByRole("checkbox", { name: "选择 第二会话" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "关闭会话侧栏" }));
    fireEvent.click(screen.getByRole("button", { name: "打开会话历史" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "管理会话：第二会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    fireEvent.click(screen.getByRole("button", { name: "打开工作台导航" }));
    fireEvent.click(screen.getByRole("button", { name: "打开会话历史" }));
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("移动端内容区右划打开侧栏，侧栏左划关闭并取消选择", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryResult(true)));
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: /^第二会话/ });
    const workspace = document.querySelector<HTMLElement>(".chat-workspace")!;
    const sidebar = screen.getByRole("complementary", { name: "会话历史" });

    fireEvent.pointerDown(workspace, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(workspace, { pointerType: "touch", pointerId: 1, clientX: 125, clientY: 208 });
    fireEvent.pointerUp(workspace, { pointerType: "touch", pointerId: 1, clientX: 125, clientY: 208 });
    expect(sidebar).toHaveClass("is-open");

    fireEvent.click(screen.getByRole("button", { name: "管理会话：第二会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "多选" }));
    expect(screen.getByRole("checkbox", { name: "选择 第二会话" })).toBeChecked();

    fireEvent.pointerDown(sidebar, { pointerType: "touch", pointerId: 2, clientX: 240, clientY: 200 });
    fireEvent.pointerMove(sidebar, { pointerType: "touch", pointerId: 2, clientX: 130, clientY: 205 });
    fireEvent.pointerUp(sidebar, { pointerType: "touch", pointerId: 2, clientX: 130, clientY: 205 });
    expect(sidebar).not.toHaveClass("is-open");

    fireEvent.pointerDown(workspace, { pointerType: "touch", pointerId: 3, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(workspace, { pointerType: "touch", pointerId: 3, clientX: 125, clientY: 204 });
    fireEvent.pointerUp(workspace, { pointerType: "touch", pointerId: 3, clientX: 125, clientY: 204 });
    expect(sidebar).toHaveClass("is-open");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("移动端从输入框起划时不触发侧栏手势", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryResult(true)));
    renderLiveChatPage(<LiveChatPage {...props} />);
    const textbox = await screen.findByRole("textbox", { name: "消息内容" });
    const sidebar = screen.getByRole("complementary", { name: "会话历史" });

    fireEvent.pointerDown(textbox, { pointerType: "touch", pointerId: 1, clientX: 20, clientY: 200 });
    fireEvent.pointerMove(textbox, { pointerType: "touch", pointerId: 1, clientX: 140, clientY: 202 });
    fireEvent.pointerUp(textbox, { pointerType: "touch", pointerId: 1, clientX: 140, clientY: 202 });

    expect(sidebar).not.toHaveClass("is-open");
  });

  it("为高密度对话布局保留消息列样式钩子", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);

    const messageColumn = (await screen.findByRole("textbox", { name: "消息内容" }))
      .closest(".chat-workspace")
      ?.querySelector(".message-column");

    expect(messageColumn).toHaveClass("message-column--compact-end");
  });

  it("定时任务消息使用独立且与会话头像一致的标识容器", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    act(() => {
      FakeEventSource.instances.at(-1)!.emit("snapshot", {
        id: 1,
        type: "snapshot",
        sessionId: "session-1",
        messages: [{ role: "user", content: "这是定时任务发出的消息\n\n请生成日报。" }],
        lastEventId: 1,
      });
    });

    const avatar = await screen.findByLabelText("定时任务消息");
    expect(avatar.tagName).toBe("SPAN");
    expect(avatar).toHaveClass("message-avatar", "is-scheduled-avatar");
    expect(avatar).not.toHaveClass("is-user-avatar");
  });

  it("保存显示名后立即在会话页使用新的用户身份", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
      if (url === "/api/v1/profile") {
        if (init?.method === "PATCH") return new Response(JSON.stringify({ revision: "profile-r2", profile: { displayName: "小嘉" } }));
        return new Response(JSON.stringify({ revision: "profile-r1", profile: { displayName: "管理员" } }));
      }
      if (url === "/api/v1/sessions?agentId=default") return new Response(JSON.stringify({ sessions: [] }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "编辑个人资料" }));
    fireEvent.change(screen.getByRole("textbox", { name: "显示名" }), { target: { value: "小嘉" } });
    fireEvent.click(screen.getByRole("button", { name: "保存显示名" }));

    expect(await screen.findByText("小嘉")).toBeInTheDocument();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/v1/profile", expect.objectContaining({ method: "PATCH" }));
  });

  it("重新进入会话页时恢复本页缓存的 Agent", async () => {
    const agents = [
      { profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" },
      { profile: { id: "research", name: "研究 Agent", avatar: { kind: "initial", value: "研" }, status: "active", cwd: "/data/workspace/research", instructions: {}, allowedTools: [] }, revision: "r1" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
      if (url === "/api/v1/sessions?agentId=default" || url === "/api/v1/sessions?agentId=research") return new Response(JSON.stringify({ sessions: [] }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const firstPage = renderLiveChatPage(<LiveChatPage {...props} />);
    const trigger = await screen.findByRole("button", { name: "切换 Agent 或模型" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /研究 Agent/ }));
    await waitFor(() => expect(trigger).toHaveTextContent("研究 Agent"));

    firstPage.unmount();
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByRole("button", { name: "切换 Agent 或模型" })).toHaveTextContent("研究 Agent");
  });

  it("缓存的 Agent 不存在时回退到第一个可用 Agent", async () => {
    window.sessionStorage.setItem("pi-agent-web.selected-agent-id", "deleted-agent");
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByRole("button", { name: "切换 Agent 或模型" })).toHaveTextContent("默认 Agent");
    expect(window.sessionStorage.getItem("pi-agent-web.selected-agent-id")).toBeNull();
  });

  it("快速切换 Agent 时忽略上一代会话列表的迟到响应", async () => {
    const agents = [
      { profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" },
      { profile: { id: "research", name: "研究 Agent", avatar: { kind: "initial", value: "研" }, status: "active", cwd: "/data/workspace/research", instructions: {}, allowedTools: [] }, revision: "r1" },
    ];
    let defaultRequests = 0;
    let resolveResearch: ((response: Response) => void) | undefined;
    const researchSessions = new Promise<Response>((resolve) => { resolveResearch = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
      if (url === "/api/v1/sessions?agentId=research") return researchSessions;
      if (url === "/api/v1/sessions?agentId=default") {
        defaultRequests += 1;
        return new Response(JSON.stringify({ sessions: defaultRequests === 1 ? [] : [{ id: "default-latest", firstMessage: "默认最新会话", modified: "", messageCount: 1 }] }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);
    const trigger = await screen.findByRole("button", { name: "切换 Agent 或模型" });

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /研究 Agent/ }));
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /默认 Agent/ }));
    expect(await screen.findByRole("button", { name: "默认最新会话" })).toBeInTheDocument();

    await act(async () => {
      resolveResearch?.(new Response(JSON.stringify({ sessions: [{ id: "research-late", firstMessage: "迟到研究会话", modified: "", messageCount: 1 }] })));
      await researchSessions;
    });
    expect(screen.queryByRole("button", { name: "迟到研究会话" })).not.toBeInTheDocument();
  });

  it("切换会话时保留当前内容并显示加载反馈", async () => {
    let resolveSecondSession: ((response: Response) => void) | undefined;
    const secondSession = new Promise<Response>((resolve) => { resolveSecondSession = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "OpenAI", id: "MiniMax-M3", name: "MiniMax-M3" }] }));
      if (url === "/api/v1/sessions?agentId=default") return new Response(JSON.stringify({ sessions: [
        { id: "session-1", name: "第一个会话", firstMessage: "旧会话内容", modified: "", messageCount: 1 },
        { id: "session-2", name: "第二个会话", firstMessage: "新会话内容", modified: "", messageCount: 1 },
      ] }));
      if (url === "/api/v1/sessions/session-1") return new Response(JSON.stringify({
        id: "session-1", agentId: "default", messages: [{ role: "assistant", content: [{ type: "text", text: "旧会话内容" }] }], lastEventId: 0,
      }));
      if (url === "/api/v1/sessions/session-2") return secondSession;
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("旧会话内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "第二个会话" }));

    expect(screen.getByText("旧会话内容")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "正在加载会话" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第二个会话" })).toHaveAttribute("aria-busy", "true");
    fireEvent.click(screen.getByRole("button", { name: "第二个会话" }));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/v1/sessions/session-2")).toHaveLength(1);

    resolveSecondSession!(new Response(JSON.stringify({
      id: "session-2", agentId: "default", messages: [{ role: "assistant", content: [{ type: "text", text: "新会话内容" }] }], lastEventId: 0,
    })));
    expect(await screen.findByText("新会话内容")).toBeInTheDocument();
  });

  it("会话切换失败时保留当前内容并恢复操作", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "OpenAI", id: "MiniMax-M3", name: "MiniMax-M3" }] }));
      if (url === "/api/v1/sessions?agentId=default") return new Response(JSON.stringify({ sessions: [
        { id: "session-1", name: "第一个会话", firstMessage: "旧会话内容", modified: "", messageCount: 1 },
        { id: "session-2", name: "第二个会话", firstMessage: "新会话内容", modified: "", messageCount: 1 },
      ] }));
      if (url === "/api/v1/sessions/session-1") return new Response(JSON.stringify({
        id: "session-1", agentId: "default", messages: [{ role: "assistant", content: [{ type: "text", text: "旧会话内容" }] }], lastEventId: 0,
      }));
      if (url === "/api/v1/sessions/session-2") return new Response(JSON.stringify({
        error: { code: "SESSION_UNAVAILABLE", message: "会话暂不可用" },
      }), { status: 503 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("旧会话内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "第二个会话" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成");
    expect(screen.queryByText("会话暂不可用")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "查看错误详情" }).at(-1)!);
    expect(screen.getByText("会话暂不可用")).toBeInTheDocument();
    expect(screen.getByText("打开会话")).toBeInTheDocument();
    expect(screen.getByText("旧会话内容")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "正在加载会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "第二个会话" })).toBeEnabled();
  });

  it("忽略切换后与接口快照相同的 SSE 初始快照", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "OpenAI", id: "MiniMax-M3", name: "MiniMax-M3" }] }));
      if (url === "/api/v1/sessions?agentId=default") return new Response(JSON.stringify({ sessions: [
        { id: "session-1", name: "第一个会话", firstMessage: "旧会话内容", modified: "", messageCount: 1 },
        { id: "session-2", name: "第二个会话", firstMessage: "接口快照内容", modified: "", messageCount: 1 },
      ] }));
      if (url === "/api/v1/sessions/session-1") return new Response(JSON.stringify({
        id: "session-1", agentId: "default", messages: [{ role: "assistant", content: [{ type: "text", text: "旧会话内容" }] }], lastEventId: 3,
      }));
      if (url === "/api/v1/sessions/session-2") return new Response(JSON.stringify({
        id: "session-2", agentId: "default", messages: [{ role: "assistant", content: [{ type: "text", text: "接口快照内容" }] }], lastEventId: 7,
      }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("旧会话内容")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "第二个会话" }));
    expect(await screen.findByText("接口快照内容")).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances.some((source) => source.url.endsWith("/session-2/events"))).toBe(true));
    const source = FakeEventSource.instances.find((item) => item.url.endsWith("/session-2/events"));

    act(() => source!.emit("snapshot", {
      id: 7,
      type: "snapshot",
      sessionId: "session-2",
      messages: [{ role: "assistant", content: [{ type: "text", text: "重复快照覆盖内容" }] }],
      lastEventId: 7,
    }));

    expect(screen.getByText("接口快照内容")).toBeInTheDocument();
    expect(screen.queryByText("重复快照覆盖内容")).not.toBeInTheDocument();

    act(() => source!.emit("snapshot", {
      id: 8,
      type: "snapshot",
      sessionId: "session-2",
      messages: [{ role: "assistant", content: [{ type: "text", text: "新快照内容" }] }],
      lastEventId: 8,
    }));

    expect(screen.getByText("新快照内容")).toBeInTheDocument();
  });

  it("继承全局默认模型的新会话不会被模型列表首项覆盖", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [
        { provider: "OpenAI", id: "gpt-5.6-terra", name: "gpt-5.6-terra" },
        { provider: "OpenAI", id: "MiniMax-M3", name: "MiniMax-M3" },
      ] }));
      if (url === "/api/v1/configuration/global") return new Response(JSON.stringify({
        revision: "settings-r1",
        own: { defaultProvider: "OpenAI", defaultModel: "MiniMax-M3" },
        effective: { defaultProvider: "OpenAI", defaultModel: "MiniMax-M3" },
        diagnostics: [],
      }));
      if (url === "/api/v1/sessions?agentId=default") return new Response(JSON.stringify({ sessions: [] }));
      if (url === "/api/v1/sessions" && init?.method === "POST") return new Response(JSON.stringify({
        id: "inherits-global-session", agentId: "default", messages: [],
        model: { provider: "OpenAI", id: "MiniMax-M3", name: "MiniMax-M3" }, lastEventId: 0,
      }));
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ runId: "run-default", sessionId: "inherits-global-session", status: "running", startedAt: "2026-08-06T00:00:00.000Z" }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    await screen.findByText("MiniMax-M3");
    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "使用继承模型" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/v1/sessions/inherits-global-session/messages")).toBe(true));
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/v1/sessions/inherits-global-session/model")).toBe(false);
  });

  it("新会话采用 Agent 默认模型，并在旧快照到达时保留首条用户消息", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "lux", name: "lux-7", avatar: { kind: "initial", value: "L" }, status: "active", cwd: "/data/workspace/agents/lux", defaultModel: { provider: "lux", id: "lux-7" }, instructions: {}, allowedTools: [] }, revision: "r1" }] }));
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "system", id: "system-default", name: "系统默认" }, { provider: "lux", id: "lux-7", name: "Lux 7" }] }));
      if (url === "/api/v1/sessions?agentId=lux") return new Response(JSON.stringify({ sessions: [] }));
      if (url === "/api/v1/sessions" && init?.method === "POST") return new Response(JSON.stringify({ id: "lux-session", agentId: "lux", messages: [], model: { provider: "lux", id: "lux-7", name: "Lux 7" }, lastEventId: 0 }));
      if (url.endsWith("/messages")) return new Response(JSON.stringify({ runId: "run-lux", sessionId: "lux-session", status: "running", startedAt: "2026-08-06T00:00:00.000Z" }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByRole("heading", { name: "lux-7" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "第一条 lux 消息" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(FakeEventSource.instances.some((source) => source.url.endsWith("lux-session/events"))).toBe(true));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/v1/sessions/lux-session/messages")).toBe(true));

    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/v1/sessions/lux-session/model")).toBe(false);
    act(() => {
      FakeEventSource.instances.at(-1)!.emit("snapshot", {
        type: "snapshot", sessionId: "lux-session", messages: [{ role: "assistant", content: [{ type: "text", text: "Lux 回复" }] }], lastEventId: 1,
      });
    });
    expect(screen.getAllByText("第一条 lux 消息")).toHaveLength(3);
  });

  it("没有可用 Agent 时提示先创建，并禁用消息输入", async () => {
    window.history.replaceState({}, "", "/chat");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }));
      if (String(input) === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("请先在 Agent 管理中创建 Agent，再开始对话。"))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "消息内容" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    expect(window.location.pathname).toBe("/settings/agents");
    expect(window.location.search).toBe("?onboarding=create");
  });

  it("连续点击新对话只进入单一草稿且不创建 session", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    const newChat = screen.getByRole("button", { name: "新对话" });
    fireEvent.click(newChat);
    fireEvent.click(newChat);
    fireEvent.click(newChat);

    const postCalls = vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/sessions" && init?.method === "POST");
    expect(postCalls).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "默认 Agent" })).toBeInTheDocument();
  });

  it("可在侧栏重命名会话并从归档列表恢复会话", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "管理会话：测试" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    const renameInput = screen.getByRole("textbox", { name: "重命名会话" });
    fireEvent.change(renameInput, { target: { value: "重命名结果" } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => expect(screen.getByRole("button", { name: "重命名结果" })).toBeInTheDocument());
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === "/api/v1/sessions/session-1" && init?.method === "PATCH")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    expect(await screen.findByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "恢复旧会话" }));
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url) === "/api/v1/sessions/archived-1/archive" && init?.method === "DELETE")).toBe(true));
  });

  it("全部恢复按服务端归档范围确认并刷新两个列表", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "查看已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    await screen.findByRole("dialog", { name: "已归档会话" });

    fireEvent.click(screen.getByRole("button", { name: "全部恢复" }));
    await screen.findByRole("dialog", { name: "确认恢复 1 个会话" });
    fireEvent.click(screen.getByRole("button", { name: "恢复全部会话" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/v1/sessions?agentId=default")).toHaveLength(2));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === "/api/v1/sessions?agentId=default&archived=true")).toHaveLength(2);
    const previewCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/sessions/bulk/preview");
    const executeCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/sessions/bulk");
    expect(JSON.parse(String(previewCall?.[1]?.body))).toEqual({
      action: "restore",
      target: { mode: "all_archived", agentId: "default" },
    });
    expect(JSON.parse(String(executeCall?.[1]?.body))).toEqual({
      action: "restore",
      target: { mode: "all_archived", agentId: "default" },
      fingerprint: "fingerprint-1",
    });
    expect(screen.getByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
  });

  it("全部删除含定时任务时使用强化确认且归档对话框保持打开", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "查看已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    await screen.findByRole("dialog", { name: "已归档会话" });

    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    expect(await screen.findByRole("button", { name: "删除会话并停用任务" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除会话并停用任务" }));

    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/bulk"));
    const executeCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/sessions/bulk");
    expect(JSON.parse(String(executeCall?.[1]?.body))).toEqual({
      action: "delete",
      target: { mode: "all_archived", agentId: "default" },
      fingerprint: "fingerprint-1",
    });
    expect(screen.getByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
  });

  it("取消全部操作确认时不关闭归档对话框", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "查看已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    await screen.findByRole("dialog", { name: "已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    await screen.findByRole("dialog", { name: "确认删除 1 个会话" });

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(screen.queryByRole("dialog", { name: "确认删除 1 个会话" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
    expect(operationLog).not.toContain("fetch:POST:/api/v1/sessions/bulk");
  });

  it("全部删除失败时保留归档列表并显示服务端错误", async () => {
    const defaultFetch = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/sessions/bulk" && init?.method === "POST") {
        return new Response(JSON.stringify({ error: { code: "SESSION_BULK_PREVIEW_STALE", message: "归档范围已变化" } }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return defaultFetch(input, init);
    });
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "查看已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    await screen.findByRole("button", { name: "打开旧会话" });
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除会话并停用任务" }));

    expect(await screen.findByText("归档范围已变化")).toHaveClass("live-chat-error");
    expect(screen.getByRole("button", { name: "打开旧会话" })).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
  });

  it("全部删除当前打开的归档会话后进入新对话草稿", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "查看已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    fireEvent.click(await screen.findByRole("button", { name: "打开旧会话" }));
    await waitFor(() => expect(operationLog).toContain("fetch:GET:/api/v1/sessions/archived-1"));
    fireEvent.click(screen.getByRole("button", { name: "查看已归档会话" }));
    await screen.findByRole("dialog", { name: "已归档会话" });
    fireEvent.click(screen.getByRole("button", { name: "全部删除" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除会话并停用任务" }));

    await waitFor(() => expect(screen.getByText("新对话", { selector: ".chat-title strong" })).toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "已归档会话" })).toBeInTheDocument();
  });

  it("草稿首次发送只创建一个 session 并先建立其事件流", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "第一条消息" } });

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-new/messages"));
    expect(operationLog.filter((entry) => entry === "fetch:POST:/api/v1/sessions")).toHaveLength(1);
    expect(operationLog.indexOf("sse:/api/v1/sessions/session-new/events"))
      .toBeLessThan(operationLog.indexOf("fetch:POST:/api/v1/sessions/session-new/messages"));
  });

  it("用户发送后在首个增量前显示 Agent 等待气泡和运行状态", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "开始处理" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    expect(await screen.findByLabelText("Agent 正在处理")).toBeInTheDocument();
    expect(screen.getAllByText("默认 Agent")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();
  });

  it("运行中快照尚未持久化新用户消息时仍保持当前轮次位于历史末尾", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => source.emit("snapshot", {
      id: 2,
      messages: [
        { role: "user", content: "历史问题", __piEntryId: "history-user" },
        { role: "assistant", content: [{ type: "text", text: "历史回答" }] },
      ],
      lastEventId: 2,
    }));
    await screen.findByText("历史回答");

    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "本轮问题" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByRole("button", { name: "停止生成" });

    act(() => {
      source.emit("snapshot", {
        id: 3,
        messages: [
          { role: "user", content: "历史问题", __piEntryId: "history-user" },
          { role: "assistant", content: [{ type: "text", text: "历史回答" }] },
        ],
        lastEventId: 3,
        run: {
          runId: "run-1",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-05T08:00:00.000Z",
        },
      });
      source.emit("text_delta", { id: 4, delta: "本轮回答生成中" });
    });

    await screen.findByText("本轮回答生成中");
    const rows = [...document.querySelectorAll<HTMLElement>(".message-row")].map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("历史问题");
    expect(rows[1]).toContain("历史回答");
    expect(rows[2]).toContain("本轮问题");
    expect(rows[3]).toContain("本轮回答生成中");
  });

  it("Agent 生成期间保留输入焦点但不重复发送消息", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    const composer = screen.getByRole("textbox", { name: "消息内容" });
    fireEvent.change(composer, { target: { value: "开始处理" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByRole("button", { name: "停止生成" });

    expect(composer).toBeEnabled();
    fireEvent.change(composer, { target: { value: "下一条消息" } });
    fireEvent.keyDown(composer, { key: "Enter" });

    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith("/messages"))).toHaveLength(1);
    const stopButton = screen.getByRole("button", { name: "停止生成" });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === "/api/v1/sessions/session-1/abort")).toBe(true));
  });

  it("从服务端 snapshot 恢复正在生成的等待状态", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    act(() => {
      FakeEventSource.instances.at(-1)!.emit("snapshot", {
        id: 8,
        type: "snapshot",
        sessionId: "session-1",
        messages: [],
        lastEventId: 8,
        run: {
          runId: "run-1",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-05T08:00:00.000Z",
        },
      });
    });

    expect(screen.getByLabelText("Agent 正在处理")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "停止生成" })).toBeInTheDocument();
  });

  it("刷新恢复已有回答后把新 token 连续追加到同一文本块", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("snapshot", {
        id: 2,
        type: "snapshot",
        sessionId: "session-1",
        messages: [{ role: "assistant", content: [{ type: "text", text: "刷新前" }] }],
        lastEventId: 2,
        run: {
          runId: "run-1",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-05T08:00:00.000Z",
        },
      });
      source.emit("text_delta", {
        id: 3,
        type: "text_delta",
        sessionId: "session-1",
        runId: "run-1",
        delta: "刷新后",
      });
    });

    const appendedText = await screen.findByText("刷新后");
    expect(appendedText.closest("p")).toHaveTextContent("刷新前刷新后");
  });

  it("为长会话预留稳定的消息滚动条槽位", async () => {
    const { container } = renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    const messageScroll = container.querySelector<HTMLElement>(".message-scroll");
    expect(messageScroll).not.toBeNull();
    expect(window.getComputedStyle(messageScroll!).scrollbarGutter).toBe("stable");
  });

  it("会话列表只在滚动期间显示滚动条", () => {
    vi.useFakeTimers();
    try {
      const { container } = renderLiveChatPage(<LiveChatPage {...props} />);
      const navigation = container.querySelector<HTMLElement>(".session-nav");

      expect(navigation).not.toBeNull();
      expect(navigation).not.toHaveClass("is-scrolling");
      fireEvent.scroll(navigation!);
      expect(navigation).toHaveClass("is-scrolling");
      act(() => vi.advanceTimersByTime(700));
      expect(navigation).not.toHaveClass("is-scrolling");
    } finally {
      vi.useRealTimers();
    }
  });

  it("为历史中的每条用户消息展示消息导航", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    act(() => {
      FakeEventSource.instances.at(-1)!.emit("snapshot", {
        type: "snapshot",
        sessionId: "session-1",
        messages: [
          { role: "user", content: "检查当前工作目录" },
          { role: "assistant", content: [{ type: "text", text: "完成" }] },
          { role: "user", content: "继续检查附件目录" },
        ],
      });
    });

    const navigation = screen.getByRole("navigation", { name: "用户消息导航" });
    expect(navigation).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳转到用户消息 1：检查当前工作目录" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳转到用户消息 2：继续检查附件目录" })).toBeInTheDocument();
  });

  it("按 SSE 到达顺序在两段文本之间展示可折叠活动段", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("text_delta", { type: "text_delta", delta: "先说明" });
      source.emit("tool_started", { type: "tool_started", callId: "tool-1", toolName: "bash", args: { cmd: "pwd" } });
      source.emit("tool_finished", { type: "tool_finished", callId: "tool-1", toolName: "bash", result: "/data/workspace", isError: false });
      source.emit("text_delta", { type: "text_delta", delta: "再说明" });
      source.emit("tool_preparing", { type: "tool_preparing", callId: "tool-2", toolName: "write" });
      source.emit("tool_started", { type: "tool_started", callId: "tool-2", toolName: "write", args: { path: "src/app.ts" } });
    });

    const first = await screen.findByText("先说明");
    const firstTool = screen.getByRole("button", { name: "展开活动段：已完成 1 项活动" });
    const second = await screen.findByText("再说明");
    const secondTool = screen.getByRole("button", { name: "收起活动段：写入 src/app.ts" });
    expect(first.compareDocumentPosition(firstTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firstTool.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(secondTool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(firstTool).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "收起本轮全部活动" }));
    expect(first).toBeVisible();
    expect(second).toBeVisible();
    expect(screen.getByRole("button", { name: "展开活动段：写入 src/app.ts" })).toHaveAttribute("aria-expanded", "false");
  });

  it("思考过程默认不铺开全文，并在本轮结束时自动折叠活动段", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => source.emit("thinking_delta", {
      id: 1,
      type: "thinking_delta",
      sessionId: "session-1",
      delta: "先分析上下文",
    }));

    expect(screen.getByRole("button", { name: "收起活动段：正在思考" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开思考详情" })).toBeInTheDocument();
    expect(screen.getByText("先分析上下文").closest(".collapsible-region")).toHaveAttribute("aria-hidden", "true");

    fireEvent.click(screen.getByRole("button", { name: "展开思考详情" }));
    expect(await screen.findByText("先分析上下文")).toBeInTheDocument();

    act(() => source.emit("thinking_finished", {
      id: 2,
      type: "thinking_finished",
      sessionId: "session-1",
    }));

    act(() => source.emit("completed", {
      id: 3,
      type: "completed",
      sessionId: "session-1",
    }));

    expect(screen.getByRole("button", { name: "展开活动段：已完成 1 项活动" })).toBeInTheDocument();
  });

  it("工具参数生成开始时立即展示，并在同一活动项原位进入写入状态", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => source.emit("tool_preparing", {
      type: "tool_preparing",
      callId: "tool-write-1",
      toolName: "write",
    }));
    expect(screen.getByRole("button", { name: "收起活动段：编写文件内容" })).toBeInTheDocument();

    act(() => source.emit("tool_prepared", {
      type: "tool_prepared",
      callId: "tool-write-1",
      toolName: "write",
      args: { path: "src/app.ts", content: "const value = 1;" },
    }));
    expect(screen.getByRole("button", { name: "收起活动段：编写 src/app.ts" })).toBeInTheDocument();

    act(() => source.emit("tool_started", {
      type: "tool_started",
      callId: "tool-write-1",
      toolName: "write",
      args: { path: "src/app.ts", content: "const value = 1;" },
    }));
    expect(screen.getByRole("button", { name: "收起活动段：写入 src/app.ts" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /write 工具详情/ })).toHaveLength(1);
  });

  it("中止准备中的工具显示未执行，失败工具保持展开并显示失败数量", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("tool_preparing", { type: "tool_preparing", callId: "tool-cancelled", toolName: "write" });
      source.emit("aborted", { type: "aborted" });
    });
    fireEvent.click(screen.getByRole("button", { name: "展开活动段：已完成 1 项活动" }));
    expect(screen.getByText("写入文件")).toBeInTheDocument();
    expect(screen.getByText("未执行")).toBeInTheDocument();

    act(() => {
      source.emit("text_delta", { type: "text_delta", delta: "继续处理" });
      source.emit("tool_started", { type: "tool_started", callId: "tool-error", toolName: "bash", args: { cmd: "false" } });
      source.emit("tool_finished", { type: "tool_finished", callId: "tool-error", toolName: "bash", result: "命令失败", isError: true });
    });
    expect(screen.getByRole("button", { name: "收起活动段：1 项活动 · 1 项失败" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("执行命令")).toBeInTheDocument();
    expect(screen.getByText("失败")).toBeInTheDocument();
  });

  it("工具结束后的流式标题与正文保持独立 Markdown 结构", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("tool_started", { type: "tool_started", callId: "tool-1", toolName: "read", args: { path: "attachments/a.md" } });
      source.emit("tool_finished", { type: "tool_finished", callId: "tool-1", toolName: "read", result: "读取完成", isError: false });
      source.emit("text_delta", { type: "text_delta", delta: "## 总结\n\n" });
      source.emit("text_delta", { type: "text_delta", delta: "这是正文。" });
    });

    expect(await screen.findByRole("heading", { name: "总结", level: 2 })).toBeInTheDocument();
    const bodyText = await screen.findByText("这是正文。");
    expect(bodyText.closest("p")).toHaveTextContent("这是正文。");
  });

  it("从 snapshot 恢复工具入参和结果", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("snapshot", {
        type: "snapshot",
        sessionId: "session-1",
        messages: [
          { role: "user", content: "检查目录" },
          { role: "assistant", content: [{ type: "toolCall", id: "tool-1", name: "bash", arguments: { cmd: "pwd" } }] },
          { role: "toolResult", toolCallId: "tool-1", toolName: "bash", content: [{ type: "text", text: "/data/workspace" }], isError: false },
        ],
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "展开活动段：已完成 1 项活动" }));
    fireEvent.click(screen.getByRole("button", { name: "展开 bash 工具详情" }));
    expect(screen.getByText(/"cmd": "pwd"/)).toBeInTheDocument();
    expect(screen.getByText("/data/workspace")).toBeInTheDocument();
  });

  it("上传附件后携带相对路径发送并在用户消息中展示媒体", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const file = new File(["image"], "图片.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("添加附件"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("5 B")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "分析图片" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => {
      const messageCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/sessions/session-1/messages");
      expect(messageCall).toBeDefined();
      expect(JSON.parse(String(messageCall?.[1]?.body))).toMatchObject({
        text: "分析图片",
        filePaths: ["attachments/图片.png"],
      });
    });
    expect(screen.getByRole("img", { name: "图片.png" })).toBeInTheDocument();
  });

  it("从剪贴板粘贴图片时上传为附件且不保留图片占位文本", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const image = new File(["image"], "clipboard.png", { type: "image/png" });
    const textbox = screen.getByRole("textbox", { name: "消息内容" });

    fireEvent.paste(textbox, {
      clipboardData: {
        items: [{ kind: "file", type: "image/png", getAsFile: () => image }],
        getData: (type: string) => type === "text/plain" ? "[图片]" : "",
      },
    });

    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/agents/default/attachments"));
    expect(screen.getByText("clipboard.png")).toBeInTheDocument();
    expect(textbox).toHaveValue("");
  });

  it("按 Agent 文本中的协议位置展示工作目录文件", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("text_delta", { type: "text_delta", delta: "先看结果\n<pi_agent_files version=\"1\">\n{\"files\":[{\"path\":\"attachments/agent-output.png\"}]}\n</pi_agent_files>\n后续说明" });
    });

    const before = await screen.findByText("先看结果");
    const image = await screen.findByRole("img", { name: "agent-output.png" });
    const after = await screen.findByText("后续说明");
    expect(before.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(image.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("在同一会话中跨消息连续切换图片", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("snapshot", {
        type: "snapshot",
        sessionId: "session-1",
        messages: [
          { role: "user", content: '第一张\n<pi_agent_files version="1">\n{"files":[{"path":"attachments/first.png"}]}\n</pi_agent_files>' },
          { role: "assistant", content: [{ type: "text", text: '<pi_agent_files version="1">\n{"files":[{"path":"attachments/second.png"}]}\n</pi_agent_files>' }] },
        ],
      });
    });

    await screen.findByRole("img", { name: "first.png" });
    await screen.findByRole("img", { name: "second.png" });
    fireEvent.click(screen.getByRole("button", { name: "全屏预览 first.png" }));

    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一张图片" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
  });

  it("文件协议结束标签独立到达时无需刷新立即展示文件", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => {
      source.emit("text_delta", { type: "text_delta", delta: '<pi_agent_files version="1">\n{"files":[{"path":"attachments/agent-output.png"}]}\n' });
      source.emit("text_delta", { type: "text_delta", delta: "</pi_agent_files>" });
    });

    expect(await screen.findByRole("img", { name: "agent-output.png" })).toBeInTheDocument();
  });
});

describe("LiveChatPage TTS 自动播放资格", () => {
  it("首次进入最新 Session 时不自动播放历史回答", async () => {
    installTtsFetch({
      messages: [{ role: "assistant", content: [{ type: "text", text: "历史回答不应自动播放。" }] }],
    });
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("历史回答不应自动播放。")).toBeInTheDocument();
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });

    expect(ttsRequests()).toHaveLength(0);
  });

  it("恢复服务端正在运行的回答后完成生成也不自动播放", async () => {
    installTtsFetch({ messages: [] });
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const source = FakeEventSource.instances.at(-1)!;

    act(() => source.emit("snapshot", {
      id: 1,
      type: "snapshot",
      sessionId: "session-1",
      messages: [{ role: "assistant", content: [{ type: "text", text: "恢复中的回答。" }] }],
      lastEventId: 1,
      run: {
        runId: "run-restored",
        sessionId: "session-1",
        status: "running",
        startedAt: "2026-08-09T00:00:00.000Z",
      },
    }));
    expect(await screen.findByText("恢复中的回答。")).toBeInTheDocument();

    act(() => source.emit("completed", {
      id: 2,
      type: "completed",
      sessionId: "session-1",
      runId: "run-restored",
    }));
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });

    expect(ttsRequests()).toHaveLength(0);
  });

  it("仅在当前页面发送后完整回答结束时自动朗读并过滤非正文", async () => {
    installTtsFetch({ messages: [] });
    installPageAudio();
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "请回答" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await waitFor(() => expect(ttsRequests()).toHaveLength(0));
    const source = FakeEventSource.instances.at(-1)!;
    act(() => source.emit("text_delta", {
      type: "text_delta",
      delta: "可朗读结论。\n\n| 列 | 值 |\n| --- | --- |\n| A | B |\n\n```ts\nconst hidden = true;\n```\n\n公式 $x+y$ 不朗读。",
    }));

    expect(await screen.findByText("可朗读结论。")).toBeInTheDocument();
    expect(ttsRequests()).toHaveLength(0);
    act(() => source.emit("completed", { type: "completed", sessionId: "session-1", runId: "run-1" }));

    await waitFor(() => expect(ttsRequests()).toHaveLength(1));
    const body = JSON.parse(String(ttsRequests()[0][1]?.body)) as { input: string };
    expect(body.input).toContain("可朗读结论");
    expect(body.input).toContain("公式 不朗读");
    expect(body.input).not.toMatch(/hidden|列|x\+y/);
    expect(await screen.findByRole("button", { name: "停止朗读" })).toBeInTheDocument();
  });

  it("流式播报在回答完成前开始且不会因后续增量重播首段", async () => {
    installTtsFetch({ messages: [], streamPlayback: true });
    installPageAudio();
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "流式回答" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    const source = FakeEventSource.instances.at(-1)!;
    const first = `${"这是稳定的流式首段".repeat(8)}。`;
    act(() => source.emit("text_delta", { type: "text_delta", delta: first }));
    await waitFor(() => expect(ttsRequests()).toHaveLength(1));

    act(() => source.emit("text_delta", { type: "text_delta", delta: "最后一句。" }));
    await act(async () => { await Promise.resolve(); });
    expect(ttsRequests()).toHaveLength(1);
    act(() => source.emit("completed", { type: "completed", sessionId: "session-1", runId: "run-1" }));
    await waitFor(() => expect(ttsRequests()).toHaveLength(2));

    const inputs = ttsRequests().map(([, init]) => (JSON.parse(String(init?.body)) as { input: string }).input);
    expect(inputs.filter((input) => input === first)).toHaveLength(1);
    expect(inputs[1]).toBe("最后一句。");
  });

  it("手动朗读按钮可停止，切换 Session 也会立即停止", async () => {
    installTtsFetch({
      messages: [{ role: "assistant", content: [{ type: "text", text: "第一会话回答。" }] }],
      secondSessionMessages: [{ role: "assistant", content: [{ type: "text", text: "第二会话回答。" }] }],
    });
    installPageAudio();
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("第一会话回答。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
    await waitFor(() => expect(PageFakeAudio.instances[0]?.played).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "停止朗读" }));
    expect(PageFakeAudio.instances[0].paused).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
    await waitFor(() => expect(PageFakeAudio.instances[1]?.played).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "打开会话历史" }));
    fireEvent.click(screen.getByRole("button", { name: "第二会话" }));

    await waitFor(() => expect(screen.getByText("第二会话回答。")).toBeInTheDocument());
    expect(PageFakeAudio.instances[1].paused).toBe(true);
    expect(ttsRequests()).toHaveLength(2);
  });

  it("手动朗读请求意外失败时显示可展开的统一错误提示", async () => {
    installTtsFetch({
      messages: [{ role: "assistant", content: [{ type: "text", text: "需要朗读的回答。" }] }],
      ttsFailure: true,
    });
    installPageAudio();
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("需要朗读的回答。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("操作未完成");
    fireEvent.click(screen.getByRole("button", { name: "查看错误详情" }));
    expect(screen.getByText("播放语音")).toBeInTheDocument();
  });

  it("切换到其他 Agent 时立即停止当前朗读", async () => {
    installTtsFetch({
      messages: [{ role: "assistant", content: [{ type: "text", text: "切换前回答。" }] }],
      includeSecondAgent: true,
    });
    installPageAudio();
    renderLiveChatPage(<LiveChatPage {...props} />);

    expect(await screen.findByText("切换前回答。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "朗读消息" }));
    await waitFor(() => expect(PageFakeAudio.instances[0]?.played).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "切换 Agent 或模型" }));
    fireEvent.click(screen.getByRole("option", { name: /写作 Agent/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "写作 Agent" })).toBeInTheDocument());
    expect(PageFakeAudio.instances[0].paused).toBe(true);
    expect(screen.queryByRole("button", { name: "停止朗读" })).not.toBeInTheDocument();
  });
});

/** 安装包含 TTS Agent 与可控 Session 快照的接口桩。 */
function installTtsFetch(options: {
  messages: unknown[];
  streamPlayback?: boolean;
  secondSessionMessages?: unknown[];
  includeSecondAgent?: boolean;
  ttsFailure?: boolean;
}): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/v1/agents") {
      return new Response(JSON.stringify({
        agents: [{
          profile: {
            id: "default",
            name: "默认 Agent",
            avatar: { kind: "initial", value: "π" },
            status: "active",
            cwd: "/data/workspace",
            instructions: {},
            allowedTools: [],
            ttsProfileId: "voice-1",
            ttsAutoPlay: true,
            ttsStreamPlayback: options.streamPlayback === true,
          },
          revision: "r1",
        }, ...(options.includeSecondAgent ? [{
          profile: {
            id: "writer",
            name: "写作 Agent",
            avatar: { kind: "initial", value: "写" },
            status: "active",
            cwd: "/data/workspace/writer",
            instructions: {},
            allowedTools: [],
            ttsProfileId: "voice-1",
            ttsAutoPlay: true,
            ttsStreamPlayback: false,
          },
          revision: "r2",
        }] : [])],
      }));
    }
    if (url === "/api/v1/models") {
      return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }] }));
    }
    if (url === "/api/v1/profile") {
      return new Response(JSON.stringify({ revision: "profile-r1", profile: { displayName: "管理员" } }));
    }
    if (url === "/api/v1/sessions?agentId=default") {
      return new Response(JSON.stringify({ sessions: [
        { id: "session-1", firstMessage: "测试", modified: "", messageCount: options.messages.length },
        ...(options.secondSessionMessages ? [{ id: "session-2", firstMessage: "第二会话", modified: "", messageCount: options.secondSessionMessages.length }] : []),
      ] }));
    }
    if (url === "/api/v1/sessions?agentId=writer") {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    if (url === "/api/v1/sessions/session-1") {
      return new Response(JSON.stringify({
        id: "session-1",
        agentId: "default",
        messages: options.messages,
        lastEventId: 0,
      }));
    }
    if (url === "/api/v1/sessions/session-2") {
      return new Response(JSON.stringify({
        id: "session-2",
        agentId: "default",
        messages: options.secondSessionMessages ?? [],
        lastEventId: 0,
      }));
    }
    if (url.endsWith("/messages")) {
      return new Response(JSON.stringify({
        runId: "run-1",
        sessionId: "session-1",
        status: "running",
        startedAt: "2026-08-09T00:00:00.000Z",
      }));
    }
    if (url === "/api/v1/agents/default/tts") {
      if (options.ttsFailure) {
        return new Response(JSON.stringify({ error: { code: "TTS_UNAVAILABLE", message: "语音服务暂不可用" } }), {
          status: 503,
        });
      }
      return new Response(new Blob(["audio"], { type: "audio/mpeg" }), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
}

/** 安装可控音频边界；对象 URL 沿用 Node 24 的原生实现。 */
function installPageAudio(): void {
  vi.stubGlobal("Audio", PageFakeAudio);
}

/** 返回当前测试已发出的语音合成请求。 */
function ttsRequests(): Array<[input: string | URL | Request, init?: RequestInit]> {
  return vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/agents/default/tts");
}
