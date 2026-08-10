import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { WebResearchPage } from "./web-research-page";

describe("WebResearchPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("展示完整的资源与安全限制，并保存修改后的配置", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/capabilities/web-research" && init?.method === "PATCH") {
        return json({ revision: "r2", config: JSON.parse(String(init.body)) .config });
      }
      if (url === "/api/v1/capabilities/web-research") {
        return json({ revision: "r1", config: DEFAULT_WEB_RESEARCH_CONFIG });
      }
      return json({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WebResearchPage />);

    expect(await screen.findByRole("spinbutton", { name: "正文最大字符数" })).toHaveValue(20_000);
    expect(screen.getByRole("button", { name: "测试连接" })).toHaveClass("configuration-secondary-action");
    expect(screen.getByRole("button", { name: "保存更改" })).toHaveClass("configuration-primary-action");
    expect(screen.getByRole("spinbutton", { name: "最大重定向次数" })).toHaveValue(3);
    expect(screen.getByRole("spinbutton", { name: "最大响应大小" })).toHaveValue(2);
    fireEvent.change(screen.getByRole("spinbutton", { name: "正文最大字符数" }), { target: { value: "30000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/capabilities/web-research",
      expect.objectContaining({ method: "PATCH", body: expect.stringContaining("30000") }),
    ));
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 });
}
