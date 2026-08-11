import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG, type WebResearchSettingsDocument } from "../../../shared/web-research-contracts";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { SearchProviderList } from "./search-provider-list";

const settings: WebResearchSettingsDocument = {
  revision: "config-1",
  credentialRevision: "credential-1",
  credentials: [{ providerId: "bocha", type: "api_key", configured: true }],
  egressProfiles: [],
  providerTemplates: [],
  config: {
    ...DEFAULT_WEB_RESEARCH_CONFIG,
    searchProviders: [
      { id: "managed-searxng", name: "内置 SearXNG", type: "searxng", connectionMode: "managed", enabled: true, timeoutMs: 10_000 },
      { id: "bocha", name: "博查", type: "bocha", connectionMode: "official", enabled: false, timeoutMs: 8_000 },
    ],
  },
};

describe("SearchProviderList", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("只展示已配置渠道状态和配置入口", () => {
    vi.stubGlobal("fetch", vi.fn());
    renderWithApiTask(<SearchProviderList document={settings} online onAdd={vi.fn()} onConfigure={vi.fn()} onDocumentChange={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "已配置渠道" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加渠道" })).toBeInTheDocument();
    expect(screen.getByText("凭证已配置")).toBeInTheDocument();
    expect(screen.queryByLabelText(/请求超时/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "配置博查" }));
  });

  it("排序失败时先乐观变更，再恢复原顺序并显示错误", async () => {
    let rejectRequest: (response: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { rejectRequest = resolve; })));
    renderWithApiTask(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "下移内置 SearXNG" }));
    await waitFor(() => expect(providerNames()).toEqual(["博查", "内置 SearXNG"]));
    rejectRequest(new Response(JSON.stringify({
      error: { code: "VERSION_CONFLICT", message: "保存排序失败", requestId: "request-provider-order" },
    }), { status: 409, headers: { "Content-Type": "application/json" } }));

    await waitFor(() => expect(providerNames()).toEqual(["内置 SearXNG", "博查"]));
    expect(screen.getByText("保存排序失败")).toBeInTheDocument();
  });

  it("排序成功时只提交 revision 和完整 ID 列表", async () => {
    const reordered = {
      ...settings,
      revision: "config-2",
      config: { ...settings.config, searchProviders: [...settings.config.searchProviders].reverse() },
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(reordered), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderWithApiTask(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "下移内置 SearXNG" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/capabilities/web-research/providers/order",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ revision: "config-1", providerIds: ["bocha", "managed-searxng"] }) }),
    ));
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).not.toContain("timeoutMs");
    expect(body).not.toContain("credential");
  });
});

function Harness() {
  const [document, setDocument] = useState(settings);
  return <SearchProviderList document={document} online onAdd={vi.fn()} onConfigure={vi.fn()} onDocumentChange={setDocument} />;
}

/** 使用生产环境一致的错误分发上下文渲染渠道列表。 */
function renderWithApiTask(element: ReactElement) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}>{element}</ApiTaskProvider></ErrorToastProvider>);
}

function providerNames(): string[] {
  return screen.getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent ?? "");
}
