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
    expect(aigcStyles).toContain(".aigc-run-preview-stage {");
    expect(aigcStyles).toContain(".aigc-asset-card__preview {");
    expect(workbenchSource).toContain('import "../aigc.css";');
    expect(workbenchSource).not.toContain('className="media-attachment');
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
    expect(screen.getByRole("heading", { name: "创作与运行" }).closest(".aigc-run-page")).toHaveClass("has-readiness");
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("ComfyUI 连接正常")).toBeInTheDocument();
  });

  it("支持音频入参并在执行中展示可截断节点状态且阻止重复生成", async () => {
    vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      window.queueMicrotask(() => handler());
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{ id: "comfy-audio", name: "ComfyUI 音频", description: "", protocol: "comfyui", capability: "text-to-image", channelId: "comfy-channel", enabled: true, toolPublishEnabled: false, config: { workflowId: "workflow-audio" }, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }] }));
      if (url === "/api/v1/capabilities/aigc/channels") return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "comfy-channel", name: "本机 ComfyUI", type: "comfyui", baseUrl: "http://comfyui:8188", enabled: true, hasApiKey: false }], channelTemplates: [], credentials: [] }));
      if (url === "/api/v1/aigc/workflows/workflow-audio") return new Response(JSON.stringify({ revision: "w1", workflow: { id: "workflow-audio", name: "音频工作流", fileName: "audio.json", originalHash: "hash", nodes: [{ id: "9", type: "SaveAudio", title: "一个非常长的音频增强与保存节点名称", fields: [] }], edges: [], inputMappings: [{ id: "audio", name: "audio", nodeId: "1", field: "inputs.audio", type: "audio", required: true, description: "参考音频" }], outputMappings: [{ id: "result", name: "result", nodeId: "9", field: "outputs.audio", mediaType: "audio" }], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" } }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (url === "/api/v1/aigc/inputs" && init?.method === "POST") return new Response(JSON.stringify({ asset: { id: "audio-input", name: "voice.wav", mediaType: "audio/wav", size: 1024 } }), { status: 201 });
      if (url === "/api/v1/aigc/tasks" && init?.method === "POST") return new Response(JSON.stringify({ id: "task-audio", interfaceId: "comfy-audio", interfaceName: "ComfyUI 音频", channelId: "comfy-channel", status: "queued", inputs: {}, assets: [], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }), { status: 202 });
      if (url === "/api/v1/aigc/tasks/task-audio") return new Response(JSON.stringify({ id: "task-audio", interfaceId: "comfy-audio", interfaceName: "ComfyUI 音频", channelId: "comfy-channel", status: "running", inputs: {}, assets: [], execution: { phase: "running", currentNodeId: "9", currentNodeName: "一个非常长的音频增强与保存节点名称", currentNodeType: "SaveAudio", progressValue: 17, progressMax: 30, completedNodes: 8, totalNodes: 20, updatedAt: "2026-08-18T00:00:01.000Z" }, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:01.000Z" }));
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage({ page: "aigc-run", interfaceId: "comfy-audio" });
    const audioInput = await screen.findByLabelText("参考音频");
    expect(audioInput).toHaveAttribute("accept", "audio/*");
    fireEvent.change(audioInput, { target: { files: [new File(["audio"], "voice.wav", { type: "audio/wav" })] } });
    await screen.findByText("voice.wav");
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    const runningButton = await screen.findByRole("button", { name: "生成中" });
    const status = await screen.findByText(/执行中 · 一个非常长的音频增强与保存节点名称 · 17\/30/u);
    expect(runningButton).toBeDisabled();
    expect(screen.getByLabelText("AIGC 接口")).toBeDisabled();
    expect(status).toHaveClass("aigc-run-action-status");
    expect(status).toHaveAttribute("title", expect.stringContaining("节点 9"));
    fireEvent.click(runningButton);
    expect(fetchMock.mock.calls.filter(([url, request]) => String(url) === "/api/v1/aigc/tasks" && request?.method === "POST")).toHaveLength(1);
  });

  it("ComfyUI 图片入参支持从公开目录选择并提交公开文件引用", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{ id: "comfy-image", name: "ComfyUI 图片", description: "", protocol: "comfyui", capability: "text-to-image", channelId: "comfy-channel", enabled: true, toolPublishEnabled: false, config: { workflowId: "workflow-image" }, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }] }));
      if (url === "/api/v1/capabilities/aigc/channels") return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "comfy-channel", name: "本机 ComfyUI", type: "comfyui", baseUrl: "http://127.0.0.1:8188", enabled: true, hasApiKey: false }], channelTemplates: [], credentials: [] }));
      if (url === "/api/v1/aigc/workflows/workflow-image") return new Response(JSON.stringify({ revision: "w1", workflow: { id: "workflow-image", name: "图片工作流", fileName: "image.json", originalHash: "hash", nodes: [{ id: "1", type: "LoadImage", title: "载入图片", fields: [] }], edges: [], inputMappings: [{ id: "image", name: "image", nodeId: "1", field: "inputs.image", type: "image", required: true, description: "参考图" }], outputMappings: [], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" } }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [{ id: "public-file", name: "poster.png", mediaType: "image/png", size: 10, createdAt: "2026-08-18T00:00:00.000Z", url: "/aigc-public/files/public-file" }] }));
      if (url === "/api/v1/aigc/tasks" && init?.method === "POST") return new Response(JSON.stringify({ id: "task-image", interfaceId: "comfy-image", interfaceName: "ComfyUI 图片", channelId: "comfy-channel", status: "queued", inputs: {}, assets: [], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }), { status: 202 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage({ page: "aigc-run", interfaceId: "comfy-image" });
    fireEvent.click(await screen.findByRole("tab", { name: "公开目录" }));
    fireEvent.change(await screen.findByLabelText("参考图公开目录"), { target: { value: "public-file" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([requestUrl, init]) => String(requestUrl) === "/api/v1/aigc/tasks" && init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ inputs: { image: { assetId: "public-file", source: "public" } } });
    });
  });

  it("ComfyUI 图片入参支持读取 ComfyUI input 并直接提交文件名", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/aigc/interfaces") return new Response(JSON.stringify({ revision: "r1", interfaces: [{ id: "comfy-image", name: "ComfyUI 图片", description: "", protocol: "comfyui", capability: "text-to-image", channelId: "comfy-channel", enabled: true, toolPublishEnabled: false, config: { workflowId: "workflow-image" }, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }] }));
      if (url === "/api/v1/capabilities/aigc/channels") return new Response(JSON.stringify({ revision: "c1", credentialRevision: "k1", channels: [{ id: "comfy-channel", name: "本机 ComfyUI", type: "comfyui", baseUrl: "http://127.0.0.1:8188", enabled: true, hasApiKey: false }], channelTemplates: [], credentials: [] }));
      if (url === "/api/v1/aigc/workflows/workflow-image") return new Response(JSON.stringify({ revision: "w1", workflow: { id: "workflow-image", name: "图片工作流", fileName: "image.json", originalHash: "hash", nodes: [{ id: "1", type: "LoadImage", title: "载入图片", fields: [] }], edges: [], inputMappings: [{ id: "image", name: "image", nodeId: "1", field: "inputs.image", type: "image", required: true, description: "参考图" }], outputMappings: [], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" } }));
      if (url === "/api/v1/aigc/public-files") return new Response(JSON.stringify({ files: [] }));
      if (url.startsWith("/api/v1/aigc/comfyui-input-files")) return new Response(JSON.stringify({ files: [{ filename: "existing.png", name: "existing.png", mediaType: "image/png" }] }));
      if (url === "/api/v1/aigc/tasks" && init?.method === "POST") return new Response(JSON.stringify({ id: "task-image", interfaceId: "comfy-image", interfaceName: "ComfyUI 图片", channelId: "comfy-channel", status: "queued", inputs: {}, assets: [], createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:00.000Z" }), { status: 202 });
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage({ page: "aigc-run", interfaceId: "comfy-image" });
    fireEvent.click(await screen.findByRole("tab", { name: "ComfyUI input" }));
    fireEvent.change(await screen.findByLabelText("参考图ComfyUI input"), { target: { value: "existing.png" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([requestUrl, init]) => String(requestUrl) === "/api/v1/aigc/tasks" && init?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ inputs: { image: { filename: "existing.png", source: "comfyui_input" } } });
    });
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

  it("删除任务前明确提示同步删除全部产物", async () => {
    vi.spyOn(window, "setInterval").mockImplementation(() => 1 as unknown as ReturnType<typeof window.setInterval>);
    vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ tasks: [{ id: "task-delete", interfaceId: "interface-1", interfaceName: "海报生成", channelId: "channel-1", status: "succeeded", assetCount: 3, createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-18T00:00:01.000Z" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    renderAigcPage({ page: "aigc-tasks" });
    fireEvent.click(await screen.findByRole("button", { name: "删除任务 task-delete" }));
    expect(screen.getByRole("dialog", { name: "删除任务？" })).toHaveTextContent("3 个产物将被永久删除");
    fireEvent.click(screen.getByRole("button", { name: "删除任务和产物" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/aigc/tasks/task-delete", expect.objectContaining({ method: "DELETE" })));
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
