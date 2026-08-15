import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComposerSessionControls } from "./composer-session-controls";

const applicationStyles = readFileSync("src/web/styles.css", "utf8");

const models = [
  { provider: "openai", id: "gpt-5", name: "GPT-5", thinkingLevels: ["off", "low", "medium", "high"] as const },
  { provider: "anthropic", id: "claude", name: "Claude Sonnet", thinkingLevels: ["off", "low", "high"] as const },
];

describe("ComposerSessionControls", () => {
  it("桌面端模型菜单以模型按钮为定位基准", () => {
    expect(applicationStyles).toMatch(
      /@media \(min-width: 761px\)[\s\S]*?\.composer-model-control\s*\{\s*position:\s*relative;/u,
    );
    expect(applicationStyles).toMatch(
      /@media \(min-width: 761px\)[\s\S]*?\.composer-model-menu\s*\{\s*width:\s*min\(320px, calc\(100vw - 40px\)\);/u,
    );
  });

  it("思考按钮常态只显示图标并可从菜单切换深度", () => {
    const onThinkingLevelChange = vi.fn();
    render(<ComposerSessionControls
      models={models}
      selectedModel={models[0]}
      thinkingLevel="medium"
      onThinkingLevelChange={onThinkingLevelChange}
      onModelChange={vi.fn()}
    />);

    const trigger = screen.getByRole("button", { name: "思考深度：中" });
    expect(trigger).not.toHaveTextContent("中");
    expect(trigger.querySelector("svg.lucide-brain-circuit")).not.toBeNull();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: "高 high" }));

    expect(onThinkingLevelChange).toHaveBeenCalledWith("high");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("模型按钮融入操作区并从菜单选择模型", () => {
    const onModelChange = vi.fn();
    render(<ComposerSessionControls
      models={models}
      selectedModel={models[0]}
      thinkingLevel="medium"
      onThinkingLevelChange={vi.fn()}
      onModelChange={onModelChange}
    />);

    const trigger = screen.getByRole("button", { name: "切换模型，当前 GPT-5" });
    expect(trigger).toHaveClass("composer-model-trigger");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet/ }));

    expect(onModelChange).toHaveBeenCalledWith(models[1]);
  });

  it("非推理模型禁用思考切换并说明原因", () => {
    const plainModel = { provider: "local", id: "plain", name: "Plain", thinkingLevels: ["off"] as const };
    render(<ComposerSessionControls
      models={[plainModel]}
      selectedModel={plainModel}
      thinkingLevel="off"
      onThinkingLevelChange={vi.fn()}
      onModelChange={vi.fn()}
    />);

    expect(screen.getByRole("button", { name: "思考深度：关闭；当前模型不支持调整" })).toBeDisabled();
  });

  it("使用 Escape 关闭已展开的菜单", () => {
    render(<ComposerSessionControls
      models={models}
      selectedModel={models[0]}
      thinkingLevel="medium"
      onThinkingLevelChange={vi.fn()}
      onModelChange={vi.fn()}
    />);
    const trigger = screen.getByRole("button", { name: "切换模型，当前 GPT-5" });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });

    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
