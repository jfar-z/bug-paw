import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG, type WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import { WebResearchPage } from "./web-research-page";

const config = {
  ...DEFAULT_WEB_RESEARCH_CONFIG,
  enabled: true,
  searchProviders: [
    { id: "managed-searxng", name: "内置 SearXNG", type: "searxng" as const, connectionMode: "managed" as const, enabled: true, timeoutMs: 10_000 },
    { id: "bocha", name: "博查", type: "bocha" as const, connectionMode: "official" as const, enabled: true, timeoutMs: 8_000 },
  ],
};

const settings: WebResearchSettingsDocument = {
  revision: "config-1",
  credentialRevision: "credential-1",
  credentials: [{ providerId: "bocha", type: "api_key", configured: true }],
  egressProfiles: [{ id: "direct", label: "直接访问", kind: "direct", available: true }],
  providerTemplates: [
    { id: "managed-searxng", name: "内置 SearXNG", type: "searxng", connectionMode: "managed" },
    { id: "custom-searxng", name: "自定义 SearXNG", type: "searxng", connectionMode: "custom" },
    { id: "bocha", name: "博查 Web Search", type: "bocha", connectionMode: "official" },
    { id: "tavily", name: "Tavily Search", type: "tavily", connectionMode: "official" },
  ],
  config,
};

describe("WebResearchPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("明确展示三个作用域且全局保存不包含渠道", async () => {
    const fetchMock = installFetch();
    render(<WebResearchPage />);

    expect(await screen.findByRole("heading", { name: "服务状态" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "已配置渠道" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "全局检索策略" })).toBeInTheDocument();
    expect(screen.queryByText("添加类型")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "启用联网搜索" }));
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/capabilities/web-research/global", expect.objectContaining({ method: "PATCH" })));
    const request = fetchMock.mock.calls.find(([url, init]) => url === "/api/v1/capabilities/web-research/global" && init?.method === "PATCH");
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body.config).not.toHaveProperty("searchProviders");
  });

  it("从列表分别打开新增与编辑弹窗", async () => {
    installFetch();
    render(<WebResearchPage />);
    await screen.findByRole("heading", { name: "已配置渠道" });

    fireEvent.click(screen.getByRole("button", { name: "添加渠道" }));
    expect(screen.getByRole("dialog", { name: "添加搜索渠道" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭配置搜索渠道" }));

    fireEvent.click(screen.getByRole("button", { name: "配置博查" }));
    expect(screen.getByRole("dialog", { name: "配置搜索渠道" })).toBeInTheDocument();
  });

  it("渠道保存返回新文档时保留未提交的全局草稿", async () => {
    const fetchMock = installFetch();
    render(<WebResearchPage />);
    await screen.findByRole("heading", { name: "服务状态" });
    fireEvent.click(screen.getByRole("checkbox", { name: "启用联网搜索" }));

    fireEvent.click(screen.getByRole("button", { name: "配置博查" }));
    fireEvent.change(screen.getByLabelText("实例名称"), { target: { value: "博查备用" } });
    fireEvent.click(screen.getByRole("button", { name: "保存渠道" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "配置搜索渠道" })).not.toBeInTheDocument());
    expect(screen.getByRole("checkbox", { name: "启用联网搜索" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/capabilities/web-research/global", expect.anything()));
    const globalRequest = fetchMock.mock.calls.find(([url]) => url === "/api/v1/capabilities/web-research/global");
    expect(JSON.parse(String(globalRequest?.[1]?.body)).config.enabled).toBe(false);
  });

  it("全局 revision 冲突时可在最新版本上重新应用本地草稿", async () => {
    let globalWrites = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/capabilities/web-research/global" && init?.method === "PATCH") {
        globalWrites += 1;
        if (globalWrites === 1) return json({ error: { code: "VERSION_CONFLICT", message: "配置文件已被修改" } }, 409);
        const body = JSON.parse(String(init.body));
        return json({ ...settings, revision: "config-3", config: { ...body.config, searchProviders: config.searchProviders } });
      }
      if (url === "/api/v1/capabilities/web-research") {
        return json({ ...settings, revision: globalWrites ? "config-2" : "config-1", config: { ...config, maxResults: globalWrites ? 7 : 5 } });
      }
      return json({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<WebResearchPage />);
    await screen.findByRole("heading", { name: "全局检索策略" });
    fireEvent.click(screen.getByRole("button", { name: "展开全局检索策略" }));
    fireEvent.change(screen.getByLabelText("最大结果数"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存全局设置" }));

    expect(await screen.findByRole("dialog", { name: "配置已在磁盘上发生变化" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "在新版本上重新应用" }));
    await waitFor(() => expect(globalWrites).toBe(2));
    const reapplied = fetchMock.mock.calls.filter(([url]) => url === "/api/v1/capabilities/web-research/global").at(-1);
    expect(JSON.parse(String(reapplied?.[1]?.body))).toMatchObject({ revision: "config-2", config: { maxResults: 6 } });
  });
});

function installFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/v1/capabilities/web-research/global" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      return json({ ...settings, revision: "config-3", config: { ...body.config, searchProviders: config.searchProviders } });
    }
    if (url.endsWith("/providers/bocha") && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      return json({ ...settings, revision: "config-2", config: { ...config, searchProviders: config.searchProviders.map((provider) => provider.id === "bocha" ? body.provider : provider) } });
    }
    if (url === "/api/v1/capabilities/web-research") return json(settings);
    return json({ ok: true, message: "搜索服务连接正常" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
