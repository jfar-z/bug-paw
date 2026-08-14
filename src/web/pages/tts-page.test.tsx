import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { TtsPage } from "./tts-page";

function renderTtsPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><TtsPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("TtsPage", () => {
  it("说明 PCM 低延时播放需要上游流式支持", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ revision: "r1", profiles: [] }))));
    renderTtsPage();

    expect(screen.getByText(/仅对 PCM 启用边接收边播放/)).toBeInTheDocument();
    expect(screen.getByText(/上游接口.*分块流式响应/)).toBeInTheDocument();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("让删除与保存按钮使用相同的操作栏尺寸体系", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      profiles: [{ id: "profile-1", name: "默认语音", baseUrl: "https://example.test/v1", model: "speech", voice: "alloy", responseFormat: "mp3", hasApiKey: true }],
    }), { status: 200 })));

    renderTtsPage();

    expect(await screen.findByRole("button", { name: "删除" })).toHaveClass("configuration-secondary-action", "configuration-secondary-action--danger");
    expect(screen.getByRole("button", { name: "保存配置" })).toHaveClass("configuration-primary-action");
  });

  it("显示已保存的 TTS API Key 时仅请求当前 profile", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/capabilities/tts/profile-1/credential") {
        return new Response(JSON.stringify({ apiKey: "tts-secret" }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", profiles: [{ id: "profile-1", name: "默认语音", baseUrl: "https://example.test/v1", model: "speech", voice: "alloy", responseFormat: "mp3", hasApiKey: true }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderTtsPage();

    await screen.findByLabelText("TTS API Key");
    fireEvent.click(screen.getByRole("button", { name: "显示TTS API Key" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/capabilities/tts/profile-1/credential", expect.anything()));
    expect(screen.getByLabelText("TTS API Key")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("TTS API Key")).toHaveValue("tts-secret");
  });

  it("格式化回显并以对象保存模型级自定义请求参数", async () => {
    window.localStorage.clear();
    const profile = {
      id: "profile-1",
      name: "默认语音",
      baseUrl: "https://example.test/v1",
      model: "speech",
      voice: "alloy",
      responseFormat: "mp3",
      customParameters: { instructions: "模型情绪" },
      hasApiKey: true,
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ revision: "r2" }), { status: 200 });
      return new Response(JSON.stringify({ revision: "r1", profiles: [profile] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderTtsPage();

    const parameters = await screen.findByRole("textbox", { name: "TTS 自定义请求参数" });
    expect(parameters).toHaveValue('{\n  "instructions": "模型情绪"\n}');
    fireEvent.change(parameters, {
      target: { value: '{\n  "response_format": "pcm",\n  "instructions": "用愉快的情绪朗读"\n}' },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const saved = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    const body = JSON.parse(String(saved?.[1]?.body));
    expect(body.customParameters).toEqual({
      response_format: "pcm",
      instructions: "用愉快的情绪朗读",
    });
  });

  it("本地拒绝非法 JSON 和 input 覆盖且不发送保存请求", async () => {
    window.localStorage.clear();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
      revision: "r1",
      profiles: [{
        id: "profile-1",
        name: "默认语音",
        baseUrl: "https://example.test/v1",
        model: "speech",
        voice: "alloy",
        responseFormat: "mp3",
        customParameters: {},
        hasApiKey: true,
      }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderTtsPage();

    const parameters = await screen.findByRole("textbox", { name: "TTS 自定义请求参数" });
    fireEvent.change(parameters, { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("TTS 自定义请求参数必须是有效的 JSON")).toBeInTheDocument();

    fireEvent.change(parameters, { target: { value: '{"input":"覆盖"}' } });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));
    expect(await screen.findByText("TTS 自定义请求参数不能覆盖 input")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH" || init?.method === "POST")).toBe(false);
  });

  it("未声明的配置加载错误进入全局 Toast", async () => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network secret"); }));
    renderTtsPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("network secret")).not.toBeInTheDocument();
  });
});
