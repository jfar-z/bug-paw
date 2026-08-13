import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentModelMenu } from "./agent-model-menu";

const models = [
  { provider: "openai", id: "gpt-5", name: "GPT-5" },
  { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
];

describe("AgentModelMenu", () => {
  it("选择 Agent 后回调并关闭菜单，图片头像使用 Agent 资源地址", () => {
    const onSelectAgent = vi.fn();
    const agents = [
      {
        profile: {
          id: "research", name: "研究员", cwd: "/data/workspace/agents/research", status: "active" as const,
          avatar: { kind: "image" as const, revision: "avatar-r1", mediaType: "image/png" as const },
          description: "", instructions: { role: "", behavior: "", rules: "", user: "" }, allowedTools: [],
          createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z", version: 1 as const,
        },
        revision: "r1",
      },
      {
        profile: {
          id: "writer", name: "写作者", cwd: "/data/workspace/agents/writer", status: "active" as const,
          avatar: { kind: "initial" as const, value: "写" },
          description: "", instructions: { role: "", behavior: "", rules: "", user: "" }, allowedTools: [],
          createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z", version: 1 as const,
        },
        revision: "r2",
      },
    ];
    render(<AgentModelMenu agents={agents} selectedAgentId="research" models={models} onSelectAgent={onSelectAgent} />);

    const trigger = screen.getByRole("button", { name: "切换 Agent" });
    expect(document.querySelector(".agent-model-menu__avatar")).toHaveAttribute("src", "/api/v1/agents/research/avatar?v=avatar-r1");
    fireEvent.click(trigger);
    const writerOption = screen.getByRole("option", { name: /写作者/ });
    expect(writerOption).toHaveClass("agent-model-menu__agent-option");
    fireEvent.click(writerOption);

    expect(onSelectAgent).toHaveBeenCalledWith("writer");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("顶部菜单只展示 Agent，不再混入模型选项", () => {
    render(
      <AgentModelMenu
        agent={{ id: "default", name: "默认 Agent", avatarText: "π" }}
        models={models}
        selectedModel={models[0]}
      />,
    );

    const trigger = screen.getByRole("button", { name: "切换 Agent" });
    expect(trigger).toHaveTextContent("默认 Agent");
    expect(trigger).not.toHaveTextContent("GPT-5");
    fireEvent.click(trigger);

    expect(screen.queryByRole("option", { name: /Claude Sonnet/ })).not.toBeInTheDocument();
  });

  it("支持打开并使用 Escape 关闭 Agent 菜单", async () => {
    render(
      <AgentModelMenu
        agents={[{
          profile: {
            id: "default", name: "默认 Agent", cwd: "/data/workspace", status: "active" as const,
            avatar: { kind: "initial" as const, value: "π" }, description: "",
            instructions: { role: "", behavior: "", rules: "", user: "" }, allowedTools: [],
            version: 1 as const, createdAt: "2026-08-06T00:00:00.000Z", updatedAt: "2026-08-06T00:00:00.000Z",
          },
          revision: "r1",
        }]}
        selectedAgentId="default"
        models={models}
      />,
    );

    const trigger = screen.getByRole("button", { name: "切换 Agent" });
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.getByRole("option", { name: /默认 Agent/ })).toBeInTheDocument());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("点击菜单外部后关闭", () => {
    render(
      <div>
        <AgentModelMenu
          agent={{ id: "default", name: "默认 Agent", avatarText: "π" }}
          models={models}
          selectedModel={models[0]}
          onSelect={vi.fn()}
        />
        <button type="button">外部按钮</button>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "切换 Agent" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "外部按钮" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
