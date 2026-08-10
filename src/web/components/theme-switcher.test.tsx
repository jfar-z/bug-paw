import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemeSwitcher } from "./theme-switcher";

describe("ThemeSwitcher", () => {
  it("只提供浅色、深色和 BUG 三种主动选择", () => {
    render(<ThemeSwitcher value="bug" onChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "浅色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "深色" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BUG" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "跟随系统" })).not.toBeInTheDocument();
  });
});
