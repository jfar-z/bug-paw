import { readFile } from "node:fs/promises";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcProviderControl, AigcWorkbenchPage } from "./aigc-workbench-page";

function renderAigcPage(route: Parameters<typeof AigcWorkbenchPage>[0]["route"] = { page: "aigc-run" }) {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <AigcWorkbenchPage route={route} />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

describe("AigcWorkbenchPage 创作台", () => {
  it("配置映射按子图名称和字段别名展示", async () => {
    const workflow = {
      id: "workflow-subgraph", name: "Krea-2", fileName: "krea-2.json", originalHash: "hash",
      nodes: [{
        id: "30", type: "subgraph-krea-2", title: "Text to Image (Krea-2 Turbo)",
        fields: [{ name: "inputs.value", label: "prompt", kind: "input", valueType: "string" }],
      }],
      edges: [], inputMappings: [], outputMappings: [],
      createdAt: "2026-09-10T00:00:00.000Z", updatedAt: "2026-09-10T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/aigc/workflows/workflow-subgraph")) return new Response(JSON.stringify({ revision: "r1", workflow }));
      if (url.endsWith("/capabilities/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      return new Response("{}");
    }));
    renderAigcPage({ page: "aigc-workflow-detail", workflowId: workflow.id });

    fireEvent.click(await screen.findByRole("button", { name: "新增入参" }));
    const nodeButton = await screen.findByRole("button", { name: "浏览节点 Text to Image (Krea-2 Turbo)" });
    expect(nodeButton).toHaveTextContent("Text to Image (Krea-2 Turbo)");
    fireEvent.click(nodeButton);
    fireEvent.click(screen.getByRole("button", { name: "选为映射节点" }));

    expect(screen.getByText("prompt")).toHaveAttribute("title", "inputs.value");
    expect(screen.getByLabelText("入参名称")).toHaveValue("prompt");
  });

  it("确认后替换原始工作流并保留当前映射", async () => {
    const workflow = {
      id: "workflow-1", name: "文生图", fileName: "old.json", originalHash: "old-hash",
      nodes: [{ id: "1", type: "KSampler", fields: [{ name: "inputs.steps", kind: "input", valueType: "int" }] }], edges: [],
      inputMappings: [{ id: "steps", name: "steps", nodeId: "1", field: "inputs.steps", type: "int", required: true }],
      outputMappings: [], createdAt: "2026-09-08T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/aigc/workflows/workflow-1/replace") && init?.method === "POST") {
        return new Response(JSON.stringify({ revision: "r2", workflow: { ...workflow, fileName: "new.json", originalHash: "new-hash" } }));
      }
      if (url.endsWith("/aigc/workflows/workflow-1")) return new Response(JSON.stringify({ revision: "r1", workflow }));
      if (url.endsWith("/capabilities/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-workflow-detail", workflowId: "workflow-1" });

    const replaceButton = await screen.findByRole("button", { name: "替换原始工作流" });
    expect(screen.getAllByText("old.json")).not.toHaveLength(0);
    const file = {
      name: "new.json",
      text: vi.fn(async () => JSON.stringify({ "1": { class_type: "KSampler", inputs: { steps: 30 } } })),
    } as unknown as File;
    fireEvent.change(screen.getByLabelText("替换原始工作流文件"), { target: { files: [file] } });

    expect(await screen.findByRole("heading", { name: "替换为“new.json”？" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认替换" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/replace"))).toBe(true));
    const request = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/replace"));
    expect(JSON.parse(String(request?.[1]?.body))).toMatchObject({ revision: "r1", fileName: "new.json" });
    expect(await screen.findByText("已替换原始工作流，现有映射和接口配置保持不变")).toBeInTheDocument();
    expect(screen.getAllByText("new.json").length).toBeGreaterThan(0);
    expect(replaceButton).toBeInTheDocument();
  });

  it("接口详情保存正式发布开关，并保持其他配置不变", async () => {
    const item = {
      id: "interface-1", name: "测试接口", description: "", protocol: "openai", capability: "text-to-image",
      toolDescription: "Agent-only interface instructions",
      channelId: "channel-1", enabled: true, toolPublishEnabled: false, config: { model: "test" },
      createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/aigc/interfaces/interface-1") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ ...item, ...body }));
      }
      if (url.endsWith("/aigc/interfaces")) return new Response(JSON.stringify({ revision: "r1", interfaces: [item] }));
      if (url.endsWith("/aigc/channels")) return new Response(JSON.stringify({ channels: [] }));
      if (url.endsWith("/aigc/workflows")) return new Response(JSON.stringify({ workflows: [] }));
      return new Response("{}");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-interface-detail", interfaceId: item.id });
    const toolDescription = await screen.findByLabelText(/^AIGC Agent/);
    expect(toolDescription).toHaveValue("Agent-only interface instructions");
    fireEvent.change(toolDescription, { target: { value: "Updated agent instructions" } });
    await waitFor(() => expect(screen.getByLabelText("AIGC 接口名称")).toHaveValue("测试接口"));
    const publish = screen.getByRole("checkbox", { name: "发布为 Agent 工具" });
    expect(publish).not.toBeChecked();
    fireEvent.click(publish);
    fireEvent.click(screen.getByRole("button", { name: "保存接口" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const body = JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")?.[1]?.body));
    expect(body).toMatchObject({ toolPublishEnabled: true, toolDescription: "Updated agent instructions", channelId: item.channelId, config: item.config });
    expect(await screen.findByText("已保存 AIGC 接口")).toBeInTheDocument();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("选择已启用接口后展示提示词表单并提交生成任务", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/aigc/interfaces") {
        return new Response(JSON.stringify({
          revision: "r1",
          interfaces: [{
            id: "interface-1",
            name: "OpenAI 文生图",
            description: "标准文生图",
            protocol: "openai",
            capability: "text-to-image",
            channelId: "channel-1",
            enabled: true,
            toolPublishEnabled: false,
            config: { model: "gpt-image-1" },
            createdAt: "2026-08-17T00:00:00.000Z",
            updatedAt: "2026-08-17T00:00:00.000Z",
          }],
        }));
      }
      if (String(input) === "/api/v1/aigc/runtime-channels") {
        return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "channel-1", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", enabled: true, timeoutMs: 30000, hasApiKey: true }], channelTemplates: [], credentials: [] }));
      }
      if (String(input) === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (String(input) === "/api/v1/aigc/tasks" && init?.method === "POST") {
        return new Response(JSON.stringify({
          id: "task-1",
          interfaceId: "interface-1",
          interfaceName: "OpenAI 文生图",
          channelId: "channel-1",
          status: "queued",
          inputs: { prompt: "一只在太空中的猫" },
          assets: [],
          createdAt: "2026-08-17T00:00:00.000Z",
          updatedAt: "2026-08-17T00:00:00.000Z",
        }), { status: 202 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage();

    expect(await screen.findByLabelText("AIGC 接口")).toHaveValue("interface-1");
    expect(await screen.findByLabelText("提示词")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "创作与运行" }).closest(".aigc-run-page")).not.toHaveClass("has-readiness");
    expect(screen.queryByText("生成结果")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));
    expect(await screen.findByText("请填写 提示词")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "一只在太空中的猫" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && String(init.body).includes("一只在太空中的猫"))).toBe(true));
    const detailLink = await screen.findByRole("link", { name: "查看任务详情" });
    expect(detailLink).toHaveAttribute("href", "/aigc/tasks/task-1");
    fireEvent.click(detailLink);
    expect(window.location.pathname).toBe("/aigc/tasks/task-1");
  });

  it.each([
    { protocol: "openai", name: "OpenAI 图片", inputName: "参考图片（可选）" },
    { protocol: "grok", name: "Grok 图片", inputName: "图片公网地址公共文件" },
  ] as const)("$protocol 接口不展示 ComfyUI input 来源", async ({ protocol, name, inputName }) => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{
        id: `${protocol}-image`, name, description: "", protocol, capability: "image-edit", channelId: `${protocol}-channel`, enabled: true, toolPublishEnabled: false,
        config: { model: "image-model" }, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
      }] }));
      if (url === "/api/v1/aigc/runtime-channels") return new Response(JSON.stringify({ channels: [{ id: `${protocol}-channel`, name, type: protocol, enabled: true, hasApiKey: true }] }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderAigcPage({ page: "aigc-run", interfaceId: `${protocol}-image` });

    expect(await screen.findByLabelText(inputName)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "ComfyUI input" })).not.toBeInTheDocument();
    expect(screen.queryByText("ComfyUI input")).not.toBeInTheDocument();
  });

  it("仅 ComfyUI 接口展示 ComfyUI input 来源", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{
        id: "comfy-image", name: "ComfyUI 图片", description: "", protocol: "comfyui", capability: "image-edit", channelId: "comfy-channel", enabled: true, toolPublishEnabled: false,
        config: { workflowId: "workflow-image" }, createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
      }] }));
      if (url === "/api/v1/aigc/runtime-channels") return new Response(JSON.stringify({ channels: [{ id: "comfy-channel", name: "本机 ComfyUI", type: "comfyui", enabled: true, hasApiKey: false }] }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (url === "/api/v1/aigc/workflows/workflow-image") return new Response(JSON.stringify({ revision: "w1", workflow: {
        id: "workflow-image", name: "图片工作流", fileName: "image.json", originalHash: "hash",
        nodes: [{ id: "1", type: "LoadImage", title: "载入图片", fields: [] }], edges: [],
        inputMappings: [{ id: "image", name: "image", nodeId: "1", field: "inputs.image", type: "image", required: true, description: "参考图" }],
        outputMappings: [], createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
      } }));
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    renderAigcPage({ page: "aigc-run", interfaceId: "comfy-image" });

    expect(await screen.findByRole("tab", { name: "ComfyUI input" })).toBeInTheDocument();
  });

  it("按创建时间排序、选择并批量删除任务", async () => {
    let deleted = false;
    const tasks = [
      { id: "task-old", interfaceId: "interface-1", interfaceName: "旧任务", channelId: "channel-1", status: "succeeded", assetCount: 1, createdAt: "2026-09-08T08:00:00.000Z", updatedAt: "2026-09-08T08:01:00.000Z" },
      { id: "task-new", interfaceId: "interface-1", interfaceName: "新任务", channelId: "channel-1", status: "succeeded", assetCount: 2, createdAt: "2026-09-09T08:00:00.000Z", updatedAt: "2026-09-09T08:01:00.000Z" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/tasks" && init?.method === "DELETE") {
        deleted = true;
        return new Response(JSON.stringify({ removedIds: ["task-old", "task-new"] }));
      }
      if (url === "/api/v1/aigc/tasks") return new Response(JSON.stringify({ tasks: deleted ? [] : tasks }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAigcPage({ page: "aigc-tasks" });

    await screen.findByText("新任务");
    expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual([
      "选择任务 task-new",
      "选择任务 task-old",
    ]);
    fireEvent.change(screen.getByLabelText("任务创建时间排序"), { target: { value: "asc" } });
    expect(screen.getAllByRole("checkbox").map((checkbox) => checkbox.getAttribute("aria-label"))).toEqual([
      "选择任务 task-old",
      "选择任务 task-new",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除选中（2）" }));
    expect(screen.getByText(/Agent 工作目录的附件会保留/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除选中" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ ids: ["task-old", "task-new"] });
    expect(await screen.findByText(/已删除 2 个任务/)).toBeInTheDocument();
  });

});
