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

  it("未声明的配置加载错误进入全局 Toast", async () => {
    window.localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network secret"); }));
    renderTtsPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("network secret")).not.toBeInTheDocument();
  });
});
