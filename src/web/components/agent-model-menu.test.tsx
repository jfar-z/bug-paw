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

    const trigger = screen.getByRole("button", { name: "切换 Agent 或模型" });
    expect(document.querySelector(".agent-model-menu__avatar")).toHaveAttribute("src", "/api/v1/agents/research/avatar?v=avatar-r1");
    fireEvent.click(trigger);
    const writerOption = screen.getByRole("option", { name: /写作者/ });
    expect(writerOption).toHaveClass("agent-model-menu__agent-option");
    fireEvent.click(writerOption);

    expect(onSelectAgent).toHaveBeenCalledWith("writer");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("展示当前 Agent 和模型，并可选择另一个模型", () => {
    const onSelect = vi.fn();
    render(
      <AgentModelMenu
        agent={{ id: "default", name: "默认 Agent", avatarText: "π" }}
        models={models}
        selectedModel={models[0]}
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByRole("button", { name: "切换 Agent 或模型" });
    expect(trigger).toHaveTextContent("默认 Agent");
    expect(trigger).toHaveTextContent("GPT-5");
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet/ }));
    expect(onSelect).toHaveBeenCalledWith(models[1]);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("支持打开、选择和关闭菜单", async () => {
    const onSelect = vi.fn();
    render(
      <AgentModelMenu
        agent={{ id: "default", name: "默认 Agent", avatarText: "π" }}
        models={models}
        selectedModel={models[0]}
        onSelect={onSelect}
      />,
    );

    const trigger = screen.getByRole("button", { name: "切换 Agent 或模型" });
    fireEvent.click(trigger);
    const secondOption = screen.getByRole("option", { name: /Claude Sonnet/ });
    await waitFor(() => expect(secondOption).toBeInTheDocument());
    fireEvent.click(secondOption);
    expect(onSelect).toHaveBeenCalledWith(models[1]);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
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

    const trigger = screen.getByRole("button", { name: "切换 Agent 或模型" });
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "外部按钮" }));
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
