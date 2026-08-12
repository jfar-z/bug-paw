import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG, type SearchProviderConfig, type WebResearchSettingsDocument } from "../../../shared/web-research-contracts";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { SearchProviderDialog } from "./search-provider-dialog";

const bochaProvider: SearchProviderConfig = {
  id: "bocha",
  name: "博查",
  type: "bocha",
  connectionMode: "official",
  enabled: false,
  timeoutMs: 8_000,
};

const settings: WebResearchSettingsDocument = {
  revision: "config-1",
  credentialRevision: "credential-1",
  credentials: [{ providerId: "bocha", type: "api_key", configured: true }],
  egressProfiles: [{ id: "direct", label: "直接访问", kind: "direct", available: true }],
  providerTemplates: [
    { id: "custom-searxng", name: "自定义 SearXNG", type: "searxng", connectionMode: "custom" },
    { id: "bocha", name: "博查 Web Search", type: "bocha", connectionMode: "official" },
    { id: "tavily", name: "Tavily Search", type: "tavily", connectionMode: "official" },
  ],
  config: { ...DEFAULT_WEB_RESEARCH_CONFIG, searchProviders: [bochaProvider] },
};

describe("SearchProviderDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("新增博查渠道时在一个请求中提交配置与凭证", async () => {
    const fetchMock = installFetch();
    renderDialog("create");

    fireEvent.change(screen.getByLabelText("渠道类型"), { target: { value: "bocha" } });
    fireEvent.change(screen.getByLabelText("实例名称"), { target: { value: "博查主线路" } });
    fireEvent.change(screen.getByLabelText("博查主线路 API Key"), { target: { value: "test-search-key" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "立即参与路由" }));
    fireEvent.click(screen.getByRole("button", { name: "添加渠道" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/capabilities/web-research/providers",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"apiKey":"test-search-key"') }),
    ));
  });

  it("编辑时未修改凭证发送 keep", async () => {
    const fetchMock = installFetch();
    renderDialog("edit");

    fireEvent.change(screen.getByLabelText("实例名称"), { target: { value: "博查备用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存渠道" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const request = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(request.credential).toEqual({ action: "keep" });
  });

  it("明确移除凭证时发送 remove", async () => {
    const fetchMock = installFetch();
    renderDialog("edit");

    fireEvent.click(screen.getByRole("button", { name: "移除已保存凭证" }));
    fireEvent.click(screen.getByRole("button", { name: "保存渠道" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const request = JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body));
    expect(request.credential).toEqual({ action: "remove" });
  });

  it("只在主动显示时读取凭证，并在关闭弹窗后清除明文", async () => {
    const fetchMock = installFetch();
    function Harness() {
      const [open, setOpen] = useState(true);
      return open ? <SearchProviderDialog mode="edit" document={settings} provider={bochaProvider} online onSaved={vi.fn()} onDeleted={vi.fn()} onClose={() => setOpen(false)} /> : null;
    }
    renderWithApiTask(<Harness />);

    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "显示博查 API Key" }));
    await waitFor(() => expect(screen.getByLabelText("博查 API Key")).toHaveValue("stored-test-key"));
    fireEvent.click(screen.getByRole("button", { name: "关闭配置搜索渠道" }));

    expect(screen.queryByDisplayValue("stored-test-key")).not.toBeInTheDocument();
  });

  it("仅自定义 SearXNG 显示地址且高级设置默认折叠", () => {
    installFetch();
    renderDialog("create");

    expect(screen.getByLabelText("SearXNG 地址")).toBeInTheDocument();
    expect(screen.queryByLabelText("请求超时（毫秒）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "展开高级设置" }));
    expect(screen.getByLabelText("请求超时（毫秒）")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("渠道类型"), { target: { value: "tavily" } });
    expect(screen.queryByLabelText("SearXNG 地址")).not.toBeInTheDocument();
  });

  it("仅为直连搜索渠道提供获取 API Key 的官方链接", () => {
    installFetch();
    renderDialog("create");

    expect(screen.queryByRole("link", { name: "博查 获取 API Key（在新标签页打开）" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Tavily 获取 API Key（在新标签页打开）" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("渠道类型"), { target: { value: "bocha" } });
    const bochaLink = screen.getByRole("link", { name: "博查 获取 API Key（在新标签页打开）" });
    expect(bochaLink).toHaveAttribute("href", "https://open.bochaai.com");
    expect(bochaLink).toHaveAttribute("target", "_blank");
    expect(bochaLink).toHaveAttribute("rel", "noreferrer");
    expect(bochaLink.closest(".api-key-field")).toContainElement(screen.getByLabelText("博查 Web Search API Key"));

    fireEvent.change(screen.getByLabelText("渠道类型"), { target: { value: "tavily" } });
    const tavilyLink = screen.getByRole("link", { name: "Tavily 获取 API Key（在新标签页打开）" });
    expect(tavilyLink).toHaveAttribute("href", "https://app.tavily.com");
    expect(tavilyLink).toHaveAttribute("target", "_blank");
    expect(tavilyLink).toHaveAttribute("rel", "noreferrer");
    expect(tavilyLink.closest(".api-key-field")).toContainElement(screen.getByLabelText("Tavily Search API Key"));
  });

  it("未保存修改时禁用测试连接，删除使用应用内确认", async () => {
    const fetchMock = installFetch();
    const onDeleted = vi.fn();
    renderWithApiTask(<SearchProviderDialog mode="edit" document={settings} provider={bochaProvider} online onSaved={vi.fn()} onDeleted={onDeleted} onClose={vi.fn()} />);

    expect(screen.getByRole("button", { name: "测试连接" })).toBeEnabled();
    fireEvent.change(screen.getByLabelText("实例名称"), { target: { value: "已修改" } });
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "测试连接" })).toHaveAttribute("title", "请先保存当前修改");

    fireEvent.click(screen.getByRole("button", { name: "删除渠道" }));
    expect(screen.getByRole("dialog", { name: "删除搜索渠道" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/capabilities/web-research/providers/bocha", expect.objectContaining({ method: "DELETE" }));
  });
});

function renderDialog(mode: "create" | "edit") {
  return renderWithApiTask(<SearchProviderDialog mode={mode} document={settings} provider={mode === "edit" ? bochaProvider : undefined} online onSaved={vi.fn()} onDeleted={vi.fn()} onClose={vi.fn()} />);
}

/** 使用生产环境一致的错误分发上下文渲染渠道弹窗。 */
function renderWithApiTask(element: ReactElement) {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}>{element}</ApiTaskProvider></ErrorToastProvider>);
}

function installFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/providers/bocha/credential") && !init?.method) return json({ apiKey: "stored-test-key" });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url.endsWith("/test")) return json({ ok: true, message: "搜索服务连接正常" });
    return json({ ...settings, revision: "config-2", credentialRevision: "credential-2" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
