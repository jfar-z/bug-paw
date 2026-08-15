import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeSwitcher } from "./theme-switcher";

describe("ThemeSwitcher", () => {
  it("展示支持的主题并将用户选择交给调用方", () => {
    const onChange = vi.fn();
    render(<ThemeSwitcher value="bug" onChange={onChange} />);

    expect(screen.getByRole("button", { name: "浅色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "深色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BUG" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "浅色" }));

    expect(onChange).toHaveBeenCalledWith("light");
  });
});
