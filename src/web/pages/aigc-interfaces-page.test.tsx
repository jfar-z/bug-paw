import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcInterfacesPage } from "./aigc-interfaces-page";

const interfaces = [
  { id: "i1", name: "图片生成", description: "", protocol: "openai", capability: "text-to-image", channelId: "c1", enabled: true, mcpPublishEnabled: true, toolPublishEnabled: false, config: { model: "image-model" }, createdAt: "2026-10-08", updatedAt: "2026-10-08" },
  { id: "i2", name: "图片编辑", description: "", protocol: "openai", capability: "image-edit", channelId: "c1", enabled: true, mcpPublishEnabled: true, toolPublishEnabled: false, config: { model: "edit-model" }, createdAt: "2026-10-08", updatedAt: "2026-10-08" },
];
const client = { id: "key-1", name: "设计助手", interfaceIds: ["i1"], operations: ["list", "run"], createdAt: "2026-10-08" };

/** 使用统一 API 请求和错误弹窗验证真实交互，不生成上游任务。 */
function setup(failSave = false) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/aigc/mcp/clients/key-1") && init?.method === "PATCH") {
      if (failSave) return new Response(JSON.stringify({ error: { code: "MCP_CLIENT_NOT_FOUND", message: "MCP 客户端不存在或已撤销", requestId: "scope-request" } }), { status: 404 });
      return new Response(JSON.stringify({ client: { ...client, ...JSON.parse(String(init.body)) } }));
    }
    if (url.endsWith("/aigc/mcp/clients")) return new Response(JSON.stringify({ clients: [client] }));
    if (url.endsWith("/aigc/interfaces/i1") && init?.method === "PATCH") return new Response(JSON.stringify({ ...interfaces[0], ...JSON.parse(String(init.body)) }));
    if (url.endsWith("/aigc/interfaces")) return new Response(JSON.stringify({ revision: "r1", interfaces }));
    if (url.endsWith("/aigc/channels")) return new Response(JSON.stringify({ channels: [{ id: "c1", name: "图片渠道", type: "openai", enabled: true }] }));
    if (url.endsWith("/aigc/workflows")) return new Response(JSON.stringify({ workflows: [] }));
    return new Response("{}");
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><AigcInterfacesPage /></ApiTaskProvider></ErrorToastProvider>);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("接口配置与 MCP 授权", () => {
  it("列表默认不进入编辑，新建与编辑明确区分且关闭时保护未保存修改", async () => {
    const fetchMock = setup();
    await screen.findByRole("button", { name: "编辑接口 图片生成" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新增接口" }));
    expect(screen.getByRole("heading", { name: "新增接口" })).toBeInTheDocument();
    expect(screen.getByLabelText("AIGC 接口名称")).toHaveValue("");
    expect(screen.getByRole("button", { name: "创建接口" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("AIGC 接口名称"), { target: { value: "尚未保存" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭编辑" }));
    expect(screen.getByRole("heading", { name: "放弃未保存修改？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑接口 图片生成" }));
    expect(screen.getByRole("heading", { name: "编辑 · 图片生成" })).toBeInTheDocument();
    expect(screen.getByLabelText("AIGC 接口名称")).toHaveValue("图片生成");
    fireEvent.change(screen.getByLabelText("AIGC 接口名称"), { target: { value: "修改后的接口" } });
    fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/interfaces/i1") && init?.method === "PATCH")?.[1]?.body))).toMatchObject({ revision: "r1", name: "修改后的接口" });
    expect(await screen.findByText("接口修改已保存")).toBeInTheDocument();
  });

  it("已签发 Key 回填授权，通过 PATCH 新增接口且不重新签发", async () => {
    const fetchMock = setup();
    await screen.findByRole("button", { name: "编辑接口 图片生成" });
    fireEvent.click(screen.getByRole("tab", { name: /MCP 接入与授权/ }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑授权" }));
    expect(screen.getByRole("heading", { name: "编辑授权 · 设计助手" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "授权 图片生成" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "授权 图片编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    expect(await screen.findByText("授权已更新，原 Key 继续使用")).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([url, init]) => String(url).endsWith("/mcp/clients/key-1") && init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ name: "设计助手", interfaceIds: ["i1", "i2"], operations: ["list", "run"] });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("授权保存失败保留表单并展示具体错误及请求标识", async () => {
    setup(true);
    await screen.findByRole("button", { name: "编辑接口 图片生成" });
    fireEvent.click(screen.getByRole("tab", { name: /MCP 接入与授权/ }));
    fireEvent.click(await screen.findByRole("button", { name: "编辑授权" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "授权 图片编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    expect(await screen.findByText("MCP 客户端不存在或已撤销")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByRole("checkbox", { name: "授权 图片编辑" })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "查看错误详情" }));
    expect(screen.getByText("scope-request")).toBeInTheDocument();
  });
});
