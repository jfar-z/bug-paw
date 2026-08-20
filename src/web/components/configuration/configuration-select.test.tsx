import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConfigurationSelect } from "./configuration-select";

describe("ConfigurationSelect", () => {
  it("筛选选项并保留标量原始类型", () => {
    const onChange = vi.fn();
    render(<ConfigurationSelect ariaLabel="采样器" options={[
      { value: "euler", label: "Euler" },
      { value: 2, label: "DPM 2" },
      { value: false, label: "禁用" },
    ]} value="euler" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "采样器" }));
    fireEvent.change(screen.getByRole("textbox", { name: "筛选采样器" }), { target: { value: "DPM" } });
    expect(screen.queryByRole("option", { name: "Euler" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "DPM 2" }));

    expect(onChange).toHaveBeenCalledWith(2);
    expect(screen.getByRole("button", { name: "采样器" })).toHaveAttribute("aria-expanded", "false");
  });

  it("支持方向键确认与 Escape 关闭", () => {
    const onChange = vi.fn();
    render(<ConfigurationSelect ariaLabel="渠道" options={[
      { value: "local", label: "本机" },
      { value: "remote", label: "远程" },
    ]} value="local" onChange={onChange} />);

    const trigger = screen.getByRole("button", { name: "渠道" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("textbox", { name: "筛选渠道" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("remote");

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
