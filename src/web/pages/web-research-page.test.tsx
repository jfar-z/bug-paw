import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG } from "../../shared/web-research-contracts";
import { WebResearchPage } from "./web-research-page";

describe("WebResearchPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("展示完整的资源与安全限制，并保存修改后的配置", async () => {
    const config = {
      ...DEFAULT_WEB_RESEARCH_CONFIG,
      searchProviders: [{ id: "managed-searxng", name: "内置 SearXNG", type: "searxng" as const, connectionMode: "managed" as const, enabled: true, timeoutMs: 10_000 }],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/capabilities/web-research" && init?.method === "PATCH") {
        return json({ revision: "r2", config: JSON.parse(String(init.body)) .config });
      }
      if (url === "/api/v1/capabilities/web-research") {
        return json({ revision: "r1", credentialRevision: "c1", credentials: [], egressProfiles: [], providerTemplates: [], config });
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
    const connectionCard = screen.getByRole("heading", { name: "连接设置" }).closest("section");
    expect(connectionCard).not.toBeNull();
    const enableToggle = connectionCard!.querySelector<HTMLLabelElement>(":scope > label");
    expect(enableToggle).not.toBeNull();
    expect(enableToggle).toHaveClass("configuration-capability-toggle");
    expect(within(enableToggle!).getByRole("checkbox")).toHaveAccessibleName("启用联网搜索");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/capabilities/web-research/providers/managed-searxng/test",
      expect.objectContaining({ method: "POST" }),
    ));
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
