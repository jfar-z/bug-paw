import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentAvatar } from "./agent-avatar";

describe("AgentAvatar", () => {
  it("优先显示图片头像，加载失败后回退文字头像", () => {
    render(<AgentAvatar agent={{ profile: { id: "research", name: "研究助手", avatar: { kind: "image", revision: "r1", mediaType: "image/png" } } }} label="研究助手头像" />);

    const image = screen.getByRole("img", { name: "研究助手头像" });
    expect(image).toHaveAttribute("src", "/api/v1/agents/research/avatar?v=r1");
    fireEvent.error(image);
    expect(screen.getByLabelText("研究助手头像")).toHaveTextContent("研");
  });
});
