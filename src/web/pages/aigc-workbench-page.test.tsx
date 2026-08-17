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
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.replaceState({}, "", "/");
  });

  it("渠道超过三个时使用与接口等高的下拉框", () => {
    const onChange = vi.fn();
    render(<AigcProviderControl options={[
      { value: "openai", label: "OpenAI", count: 1 },
      { value: "grok", label: "Grok", count: 2 },
      { value: "comfyui", label: "ComfyUI", count: 1 },
      { value: "future", label: "Future", count: 3 },
    ]} value="openai" onChange={onChange} />);

    const channelSelect = screen.getByLabelText("渠道");
    expect(channelSelect).toHaveValue("openai");
    expect(screen.queryByRole("tablist", { name: "生成服务" })).not.toBeInTheDocument();
    fireEvent.change(channelSelect, { target: { value: "future" } });
    expect(onChange).toHaveBeenCalledWith("future");
  });

  it("由两个懒加载入口共享独立页面样式", async () => {
    const [globalStyles, aigcStyles, workbenchSource, channelsSource] = await Promise.all([
      readFile("src/web/styles.css", "utf8"),
      readFile("src/web/aigc.css", "utf8"),
      readFile("src/web/pages/aigc-workbench-page.tsx", "utf8"),
      readFile("src/web/pages/aigc-channels-page.tsx", "utf8"),
    ]);

    expect(globalStyles).not.toContain(".aigc-workbench-page {");
    expect(aigcStyles).toContain(".aigc-workbench-page {");
    expect(workbenchSource).toContain('import "../aigc.css";');
    expect(channelsSource).toContain('import "../aigc.css";');
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
      if (String(input) === "/api/v1/capabilities/aigc/channels") {
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

  it("任务完成后在创作台切换预览图片视频和音频产物", async () => {
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      window.queueMicrotask(() => handler());
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{ id: "interface-1", name: "多媒体生成", description: "", protocol: "openai", capability: "text-to-image", channelId: "channel-1", enabled: true, toolPublishEnabled: false, config: { model: "gpt-image-1" }, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" }] }));
      if (url === "/api/v1/capabilities/aigc/channels") return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "channel-1", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", enabled: true, timeoutMs: 30000, hasApiKey: true }], channelTemplates: [], credentials: [] }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (url === "/api/v1/aigc/tasks" && init?.method === "POST") return new Response(JSON.stringify({ id: "task-media", interfaceId: "interface-1", interfaceName: "多媒体生成", channelId: "channel-1", status: "queued", inputs: { prompt: "海边日落" }, assets: [], createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" }), { status: 202 });
      if (url === "/api/v1/aigc/tasks/task-media") return new Response(JSON.stringify({ id: "task-media", interfaceId: "interface-1", interfaceName: "多媒体生成", channelId: "channel-1", status: "succeeded", inputs: { prompt: "海边日落" }, assets: [{ id: "image-1", name: "poster.png", mediaType: "image/png", size: 2048, createdAt: "2026-08-17T00:00:01.000Z" }, { id: "video-1", name: "clip.mp4", mediaType: "video/mp4", size: 4096, createdAt: "2026-08-17T00:00:01.000Z" }, { id: "audio-1", name: "sound.wav", mediaType: "audio/wav", size: 1024, createdAt: "2026-08-17T00:00:01.000Z" }], createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:01.000Z", finishedAt: "2026-08-17T00:00:01.000Z" }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage();
    fireEvent.change(await screen.findByLabelText("提示词"), { target: { value: "海边日落" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    expect(await screen.findByRole("img", { name: "poster.png" })).toHaveAttribute("src", "/api/v1/aigc/tasks/task-media/assets/image-1");
    fireEvent.click(screen.getByRole("tab", { name: /clip\.mp4/ }));
    expect(screen.getByLabelText("clip.mp4")).toHaveAttribute("controls");
    fireEvent.click(screen.getByRole("tab", { name: /sound\.wav/ }));
    expect(screen.getByLabelText("sound.wav")).toHaveAttribute("controls");
    expect(screen.getByRole("link", { name: "下载 sound.wav" })).toHaveAttribute("href", "/api/v1/aigc/tasks/task-media/assets/audio-1?download=1");
  });

  it("可直接进入 ComfyUI 接口并显示真实连接检查", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{ id: "openai-1", name: "OpenAI 图片", description: "", protocol: "openai", capability: "text-to-image", channelId: "openai-channel", enabled: true, toolPublishEnabled: false, config: { model: "gpt-image-1" }, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" }, { id: "comfy-1", name: "ComfyUI 海报", description: "", protocol: "comfyui", capability: "text-to-image", channelId: "comfy-channel", enabled: true, toolPublishEnabled: false, config: { workflowId: "workflow-1" }, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" }] }));
      if (url === "/api/v1/capabilities/aigc/channels") return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "comfy-channel", name: "本机 ComfyUI", type: "comfyui", baseUrl: "http://comfyui:8188", enabled: true, timeoutMs: 30000, hasApiKey: false }], channelTemplates: [], credentials: [] }));
      if (url === "/api/v1/aigc/workflows/workflow-1") return new Response(JSON.stringify({ revision: "w1", workflow: { id: "workflow-1", name: "海报工作流", fileName: "poster.json", originalHash: "hash", nodes: [], edges: [], inputMappings: [{ id: "prompt", name: "prompt", nodeId: "1", field: "text", type: "string", required: true, description: "提示词" }], outputMappings: [], createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" } }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (url === "/api/v1/capabilities/aigc/channels/comfy-channel/test" && init?.method === "POST") return new Response(JSON.stringify({ ok: true, message: "ComfyUI 连接正常" }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage({ page: "aigc-run", interfaceId: "comfy-1" });

    expect(await screen.findByLabelText("AIGC 接口")).toHaveValue("comfy-1");
    expect(screen.getByRole("tab", { name: /ComfyUI/ })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText("提示词")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("ComfyUI 连接正常")).toBeInTheDocument();
  });

  it("在任务详情直接预览媒体产物并保留明确下载入口", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "task-asset", interfaceId: "comfy-1", interfaceName: "ComfyUI 海报", channelId: "comfy-channel", status: "succeeded", inputs: { prompt: "未来城市" },
      assets: [{ id: "image-1", name: "poster.png", mediaType: "image/png", size: 2048, createdAt: "2026-08-17T00:00:00.000Z" }, { id: "video-1", name: "clip.mp4", mediaType: "video/mp4", size: 4096, createdAt: "2026-08-17T00:00:00.000Z" }],
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:01:00.000Z",
    }))));

    renderAigcPage({ page: "aigc-task-detail", taskId: "task-asset" });

    expect(await screen.findByRole("img", { name: "poster.png" })).toHaveAttribute("src", "/api/v1/aigc/tasks/task-asset/assets/image-1");
    expect(screen.getByLabelText("clip.mp4")).toHaveAttribute("controls");
    const downloads = screen.getAllByRole("link", { name: "下载" });
    expect(downloads[0]).toHaveAttribute("href", "/api/v1/aigc/tasks/task-asset/assets/image-1?download=1");
    expect(screen.getByText("未来城市")).toBeInTheDocument();
  });

  it("接口编辑切换与删除均提供应用内保护", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces" && init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{ id: "interface-1", name: "原接口", description: "", protocol: "openai", capability: "text-to-image", channelId: "channel-1", enabled: true, toolPublishEnabled: false, config: { model: "gpt-image-1" }, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" }] }));
      if (url === "/api/v1/capabilities/aigc/channels") return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "channel-1", name: "OpenAI", type: "openai", baseUrl: "https://api.openai.com/v1", enabled: true, timeoutMs: 30000, hasApiKey: true }], channelTemplates: [], credentials: [] }));
      if (url === "/api/v1/aigc/workflows") return new Response(JSON.stringify({ revision: "w1", workflows: [] }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage({ page: "aigc-interfaces" });
    const nameInput = await screen.findByLabelText("AIGC 接口名称");
    fireEvent.change(nameInput, { target: { value: "未保存接口" } });
    fireEvent.click(screen.getByRole("button", { name: "新增接口" }));
    expect(screen.getByRole("dialog", { name: "放弃未保存修改？" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(nameInput).toHaveValue("未保存接口");

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(screen.getByRole("dialog", { name: "删除接口“原接口”？" })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
});
