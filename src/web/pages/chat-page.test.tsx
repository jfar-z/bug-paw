import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPage } from "./chat-page";

describe("ChatPage identities", () => {
  it("聊天页头不重复提供主题切换", () => {
    render(<ChatPage theme="light" onThemeChange={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /当前主题/ })).not.toBeInTheDocument();
  });

  it("根据配置显示用户与 Agent 的名称和头像", () => {
    render(
      <ChatPage
        theme="light"
        onThemeChange={vi.fn()}
        userIdentity={{ displayName: "工作台用户", avatarText: "用" }}
        agentIdentity={{ displayName: "研究助手", avatarText: "研" }}
      />,
    );

    expect(screen.getAllByText("工作台用户").length).toBeGreaterThan(0);
    const userAvatar = screen.getByLabelText("工作台用户头像");
    expect(userAvatar).toHaveTextContent("用");
    expect(userAvatar.closest(".message-row")).toHaveClass("is-user");
    expect(screen.getAllByText("研究助手").length).toBeGreaterThan(0);
    const agentAvatar = screen.getByLabelText("研究助手头像");
    expect(agentAvatar).toHaveTextContent("研");
    expect(agentAvatar.closest(".message-row")).toHaveClass("is-assistant");
  });

  it("展示媒体附件、Agent 产物、流式工具状态和 TTS 预留入口", () => {
    render(<ChatPage theme="light" onThemeChange={vi.fn()} />);

    expect(screen.getByLabelText("用户上传的图片附件")).toBeInTheDocument();
    expect(screen.getByLabelText("用户上传的视频附件")).toBeInTheDocument();
    expect(screen.getByLabelText("用户上传的音频附件")).toBeInTheDocument();
    expect(screen.getByLabelText("下载用户附件")).toBeInTheDocument();
    expect(screen.getByLabelText("Agent 生成的图片产物")).toBeInTheDocument();
    expect(screen.getByLabelText("下载 Agent 产物")).toBeInTheDocument();
    expect(screen.getByLabelText("工具正在流式执行")).toBeInTheDocument();

    const ttsButton = screen.getByRole("button", { name: "朗读 Agent 消息（后续支持）" });
    expect(ttsButton).toBeDisabled();
  });

  it("将每条用户 Prompt 映射到消息导航", () => {
    render(<ChatPage theme="light" onThemeChange={vi.fn()} />);

    const navigation = screen.getByRole("navigation", { name: "用户消息导航" });
    const navigationButtons = within(navigation).getAllByRole("button");
    expect(navigation.parentElement).toHaveClass("chat-workspace");
    expect(navigationButtons).toHaveLength(2);
    expect(navigationButtons[0]).toHaveAccessibleName(/检查当前工作目录/);
    expect(navigationButtons[1]).toHaveAccessibleName(/继续检查媒体与产物展示/);
  });

  it("设备进入竖屏时收起已经打开的会话侧栏", () => {
    let orientationListener: ((event: MediaQueryListEvent) => void) | undefined;
    const mediaQuery = {
      matches: false,
      media: "(orientation: portrait)",
      onchange: null,
      addEventListener: vi.fn((_type, listener) => {
        orientationListener = listener as (event: MediaQueryListEvent) => void;
      }),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList;
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery));

    try {
      render(<ChatPage theme="light" onThemeChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "打开会话侧栏" }));

      const sidebar = document.querySelector(".chat-sidebar");
      expect(sidebar).toHaveClass("is-open");

      act(() => {
        orientationListener?.({ matches: true } as MediaQueryListEvent);
      });
      expect(sidebar).not.toHaveClass("is-open");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
