import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_WEB_RESEARCH_CONFIG, type WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { WebResearchPage } from "./web-research-page";

function renderWebResearchPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><WebResearchPage /></ApiTaskProvider></ErrorToastProvider>);
}

const config = {
  ...DEFAULT_WEB_RESEARCH_CONFIG,
  enabled: true,
  searchProviders: [
    { id: "managed-searxng", name: "内置 SearXNG", type: "searxng" as const, connectionMode: "managed" as const, enabled: true, timeoutMs: 10_000 },
    { id: "bocha", name: "博查", type: "bocha" as const, connectionMode: "official" as const, enabled: true, timeoutMs: 8_000 },
  ],
};

const settings: WebResearchSettingsDocument = {
  revision: "r1",
  credentialRevision: "c1",
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

  it("展示有序搜索服务和页面读取设置，并保存修改", async () => {
    const fetchMock = installFetch();
    renderWebResearchPage();

    expect(await screen.findByText("2 个已启用服务")).toBeInTheDocument();
    const cards = screen.getAllByRole("article");
    expect(within(cards[0]!).getByText("内置 SearXNG")).toBeInTheDocument();
    expect(within(cards[1]!).getByText("博查")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "正文最大字符数" })).toHaveValue(20_000);
    expect(screen.getByRole("combobox", { name: "页面读取出口" })).toHaveValue("direct");

    fireEvent.click(within(cards[1]!).getByRole("button", { name: "上移博查" }));
    fireEvent.click(screen.getByRole("button", { name: "展开博查" }));
    expect(screen.getByRole("button", { name: "测试博查" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/capabilities/web-research",
      expect.objectContaining({ method: "PATCH", body: expect.stringMatching(/"id":"bocha".*"id":"managed-searxng"/u) }),
    ));
  });

  it("只在点击小眼睛时读取凭证，隐藏时清除明文", async () => {
    const fetchMock = installFetch();
    renderWebResearchPage();
    fireEvent.click(await screen.findByRole("button", { name: "展开博查" }));

    const apiKey = screen.getByLabelText("博查 API Key");
    expect(apiKey).toHaveValue("");
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/credential"), expect.anything());

    fireEvent.click(screen.getByRole("button", { name: "显示博查 API Key" }));
    await waitFor(() => expect(apiKey).toHaveValue("provider-secret"));
    expect(apiKey).toHaveAttribute("type", "text");

    fireEvent.click(screen.getByRole("button", { name: "隐藏博查 API Key" }));
    expect(apiKey).toHaveValue("");
    expect(apiKey).toHaveAttribute("type", "password");
  });

  it("添加新的厂商实例并保持同厂商多实例 ID 唯一", async () => {
    const fetchMock = installFetch();
    renderWebResearchPage();
    await screen.findByText("内置 SearXNG");

    fireEvent.change(screen.getByRole("combobox", { name: "搜索服务类型" }), { target: { value: "bocha" } });
    fireEvent.click(screen.getByRole("button", { name: "添加搜索服务" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/capabilities/web-research/providers",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"id":"bocha-2"') }),
    ));
  });

  it("加载联网配置发生意外错误时显示全局 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private network detail"); }));
    renderWebResearchPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("private network detail")).not.toBeInTheDocument();
  });
});

function installFetch() {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/providers/bocha/credential") && !init?.method) return json({ apiKey: "provider-secret" });
    if (url === "/api/v1/capabilities/web-research" && init?.method === "PATCH") {
      return json({ ...settings, revision: "r2", config: JSON.parse(String(init.body)).config });
    }
    if (url === "/api/v1/capabilities/web-research/providers" && init?.method === "POST") {
      const provider = JSON.parse(String(init.body)).provider;
      return json({ ...settings, revision: "r2", config: { ...config, searchProviders: [...config.searchProviders, provider] } });
    }
    if (url === "/api/v1/capabilities/web-research") return json(settings);
    return json({ ok: true, message: "搜索服务连接正常" });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}
