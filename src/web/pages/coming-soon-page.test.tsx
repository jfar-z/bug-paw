import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ComingSoonPage } from "./coming-soon-page";

describe("ComingSoonPage", () => {
  it("只展示给定的资源管理占位信息，不请求接口", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ComingSoonPage
        eyebrow="WORKSPACE · FILES"
        title="资源管理"
        description="管理当前工作空间下的文件。"
      />,
    );

    expect(screen.getByRole("heading", { name: "资源管理" })).toBeInTheDocument();
    expect(screen.getByText("COMING SOON")).toBeInTheDocument();
    expect(screen.queryByText(/共\d+个文件/)).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
