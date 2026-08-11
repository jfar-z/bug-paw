import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentDetailPage } from "./agent-detail-page";

describe("AgentDetailPage v0 身份结构", () => {
  it("可为所选语音模型设置仅作用于 Agent 的音色覆盖", async () => {
    const profile = {
      version: 1 as const,
      id: "voice-agent",
      name: "语音 Agent",
      avatar: { kind: "initial" as const, value: "语" },
      description: "",
      status: "active" as const,
      cwd: "/data/workspace/agents/voice-agent",
      ttsProfileId: "tts-1",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: ["read"],
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [] }));
      if (url === "/api/v1/configuration/global") return new Response(JSON.stringify({ effective: {} }));
      if (url === "/api/v1/capabilities/tts") return new Response(JSON.stringify({
        revision: "tts-r1",
        profiles: [{ id: "tts-1", name: "默认语音", model: "speech", voice: "alloy", responseFormat: "pcm", hasApiKey: true }],
      }));
      if (url.includes("/resources")) return new Response(JSON.stringify({ resources: [], tools: [] }));
      const patch = init?.method === "PATCH" ? JSON.parse(String(init.body)) as { ttsVoice?: string } : undefined;
      return new Response(JSON.stringify({
        profile: patch ? { ...profile, ttsVoice: patch.ttsVoice } : profile,
        revision: patch ? "r2" : "r1",
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="voice-agent" onNavigate={vi.fn()} />);

    await screen.findByText("语音 Agent");
    fireEvent.click(screen.getByRole("button", { name: "模型与运行" }));
    const voice = await screen.findByRole("textbox", { name: "Agent 音色" });
    expect(voice).toHaveAttribute("placeholder", "继承模型音色：alloy");
    fireEvent.change(voice, { target: { value: "Cherry" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await screen.findByText("已保存");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/voice-agent", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"ttsVoice":"Cherry"'),
    }));
  });

  it("工具权限同时展示系统注入工具与已加载扩展工具，并保存选择", async () => {
    const profile = {
      version: 1 as const,
      id: "tool-agent",
      name: "工具 Agent",
      avatar: { kind: "initial" as const, value: "工" },
      description: "",
      status: "active" as const,
      cwd: "/data/workspace/agents/tool-agent",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: ["read", "knowledge_search"],
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [] }));
      if (url === "/api/v1/configuration/global") return new Response(JSON.stringify({ effective: {} }));
      if (url.includes("/resources")) return new Response(JSON.stringify({
        resources: [],
        tools: [{ name: "extension_lookup", description: "查询扩展数据", extensionPath: "/data/pi/extensions/lookup.ts", highRisk: true }],
      }));
      const patch = init?.method === "PATCH" ? JSON.parse(String(init.body)) as { allowedTools: string[] } : undefined;
      return new Response(JSON.stringify({
        profile: patch ? { ...profile, allowedTools: patch.allowedTools } : profile,
        revision: patch ? "r2" : "r1",
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="tool-agent" onNavigate={vi.fn()} />);

    await screen.findByText("工具 Agent");
    fireEvent.click(screen.getByRole("button", { name: "工具权限" }));

    expect(await screen.findByText("knowledge_search")).toBeInTheDocument();
    expect(screen.getByText("knowledge_read")).toBeInTheDocument();
    expect(screen.getByText("knowledge_manage")).toBeInTheDocument();
    expect(screen.getByText("web_read")).toBeInTheDocument();
    expect(screen.getByText("scheduled_tasks")).toBeInTheDocument();
    expect(screen.getByText("edit_own_prompts")).toBeInTheDocument();
    const extensionTool = await screen.findByRole("checkbox", { name: /extension_lookup/ });
    fireEvent.click(extensionTool);
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await screen.findByText("已保存");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/tool-agent", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining("extension_lookup"),
    }));
  });

  it("角色与行为按四个 Markdown 维度展示", () => {
    render(<AgentDetailPage agentId="default" onNavigate={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "角色与行为" }));

    expect(screen.getByText("角色与职责")).toBeInTheDocument();
    expect(screen.getByText("行为风格")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "修改 BOOTSHARP" })).toBeInTheDocument();
    expect(screen.getByText("规则")).toBeInTheDocument();
    expect(screen.getByText("用户")).toBeInTheDocument();
    expect(screen.queryByText("长期方向")).not.toBeInTheDocument();
    expect(screen.queryByText("工作原则")).not.toBeInTheDocument();
    expect(screen.queryByText("强制规则")).not.toBeInTheDocument();
    expect(screen.queryByText("禁止事项")).not.toBeInTheDocument();
  });

  it("使用规格定义的六个详情页签", () => {
    render(<AgentDetailPage agentId="default" onNavigate={vi.fn()} />);

    const tabs = screen.getByRole("navigation", { name: "Agent 详情页签" });
    expect(tabs).toHaveTextContent("基本信息");
    expect(tabs).toHaveTextContent("角色与行为");
    expect(tabs).toHaveTextContent("模型与运行");
    expect(tabs).toHaveTextContent("工具权限");
    expect(tabs).toHaveTextContent("资源");
    expect(tabs).toHaveTextContent("有效配置");
  });

  it("历史默认 Agent 的工作目录可修改", () => {
    render(<AgentDetailPage agentId="default" onNavigate={vi.fn()} />);

    expect(screen.getByRole("textbox", { name: "工作目录" })).toBeEnabled();
    expect(screen.queryByText("默认 Agent 的工作目录不能修改。")).not.toBeInTheDocument();
  });

  it("继承全局默认模型时显示实际继承值，而不是模型列表首项", async () => {
    const profile = {
      version: 1 as const,
      id: "inherits-global",
      name: "继承全局模型的 Agent",
      avatar: { kind: "initial" as const, value: "继" },
      description: "",
      status: "active" as const,
      cwd: "/data/workspace/agents/inherits-global",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: ["read"],
      createdAt: "2026-08-06T00:00:00.000Z",
      updatedAt: "2026-08-06T00:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [
        { provider: "OpenAI", id: "gpt-5.6-terra", name: "gpt-5.6-terra" },
        { provider: "OpenAI", id: "MiniMax-M3", name: "MiniMax-M3" },
      ] }));
      if (url === "/api/v1/configuration/global") return new Response(JSON.stringify({
        revision: "settings-r1",
        own: { defaultProvider: "OpenAI", defaultModel: "MiniMax-M3" },
        effective: { defaultProvider: "OpenAI", defaultModel: "MiniMax-M3" },
        diagnostics: [],
      }));
      if (url.includes("/resources")) return new Response(JSON.stringify({ resources: [], tools: [] }));
      return new Response(JSON.stringify({ profile, revision: "r1" }));
    }));
    render(<AgentDetailPage agentId="inherits-global" onNavigate={vi.fn()} />);

    await screen.findByText("继承全局模型的 Agent");
    fireEvent.click(screen.getByRole("button", { name: "模型与运行" }));

    const modelSelect = screen.getByRole("combobox", { name: "Agent 默认模型" });
    expect(modelSelect).toBeDisabled();
    expect(modelSelect).toHaveValue("");
    expect(screen.getByText("当前继承：OpenAI / MiniMax-M3")).toBeInTheDocument();
  });

  it("保存单独标题模型和思考开关", async () => {
    const profile = {
      version: 1 as const,
      id: "title-agent",
      name: "标题 Agent",
      avatar: { kind: "initial" as const, value: "标" },
      description: "",
      status: "active" as const,
      cwd: "/data/workspace/agents/title-agent",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: ["read"],
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [
        { provider: "OpenAI", id: "gpt-chat", name: "gpt-chat" },
        { provider: "OpenAI", id: "gpt-title", name: "gpt-title" },
      ] }));
      if (url === "/api/v1/configuration/global") return new Response(JSON.stringify({ effective: { defaultProvider: "OpenAI", defaultModel: "gpt-chat" } }));
      if (url === "/api/v1/capabilities/tts") return new Response(JSON.stringify({ profiles: [] }));
      if (url.includes("/resources")) return new Response(JSON.stringify({ resources: [], tools: [] }));
      const patch = init?.method === "PATCH" ? JSON.parse(String(init.body)) as { titleGeneration?: unknown } : undefined;
      return new Response(JSON.stringify({ profile: patch ? { ...profile, titleGeneration: patch.titleGeneration } : profile, revision: patch ? "r2" : "r1" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="title-agent" onNavigate={vi.fn()} />);

    await screen.findByText("标题 Agent");
    fireEvent.click(screen.getByRole("button", { name: "模型与运行" }));
    expect(await screen.findByRole("combobox", { name: "标题模型来源" })).toHaveValue("session");
    expect(screen.getByRole("checkbox", { name: "标题生成启用思考" })).not.toBeChecked();
    fireEvent.change(screen.getByRole("combobox", { name: "标题模型来源" }), { target: { value: "custom" } });
    fireEvent.change(screen.getByRole("combobox", { name: "标题单独模型" }), { target: { value: "OpenAI:gpt-title" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "标题生成启用思考" }));
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    await screen.findByText("已保存");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/title-agent", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"titleGeneration":{"modelSource":"custom","model":{"provider":"OpenAI","id":"gpt-title"},"thinkingEnabled":true}'),
    }));
  });

  it("读取 Profile 并保存合并后的四段角色指令", async () => {
    const profile = {
      version: 1 as const,
      id: "real",
      name: "真实 Agent",
      avatar: { kind: "initial" as const, value: "真" },
      description: "来自服务端",
      status: "active" as const,
      cwd: "/data/workspace/agents/real",
      instructions: { role: "旧角色", behavior: "", rules: "", user: "" },
      allowedTools: ["read"],
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
      JSON.stringify({ profile: { ...profile, instructions: init?.method === "PATCH" ? { ...profile.instructions, role: "新角色" } : profile.instructions }, revision: init?.method === "PATCH" ? "r2" : "r1" }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="real" onNavigate={vi.fn()} />);

    expect(await screen.findByText("真实 Agent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "角色与行为" }));
    fireEvent.change(screen.getByLabelText("角色与职责"), { target: { value: "新角色" } });
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/real/prompts/role", expect.objectContaining({ method: "PUT" }));
  });

  it("仅在用户点击后读取并保存 BOOTSHARP", async () => {
    const profile = {
      version: 1 as const, id: "boot", name: "初始化 Agent", avatar: { kind: "initial" as const, value: "初" },
      description: "", status: "active" as const, cwd: "/data/workspace/agents/boot",
      instructions: { role: "", behavior: "", rules: "", user: "" }, allowedTools: [],
      createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/agents/boot/prompts/bootsharp" && init?.method === "PUT") {
        return new Response(JSON.stringify({ file: "bootsharp", content: "已修改" }));
      }
      if (url === "/api/v1/agents/boot/prompts/bootsharp") {
        return new Response(JSON.stringify({ file: "bootsharp", content: "初始引导" }));
      }
      if (url === "/api/v1/models") return new Response(JSON.stringify({ models: [] }));
      if (url.includes("/resources")) return new Response(JSON.stringify({ resources: [], tools: [] }));
      return new Response(JSON.stringify({ profile, revision: "r1" }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="boot" onNavigate={vi.fn()} />);

    await screen.findByText("初始化 Agent");
    fireEvent.click(screen.getByRole("button", { name: "角色与行为" }));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/v1/agents/boot/prompts/bootsharp", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "修改 BOOTSHARP" }));
    expect(await screen.findByRole("dialog", { name: "修改 BOOTSHARP" })).toBeInTheDocument();
    expect(screen.getByLabelText("BOOTSHARP 内容")).toHaveValue("初始引导");
    fireEvent.change(screen.getByLabelText("BOOTSHARP 内容"), { target: { value: "已修改" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 BOOTSHARP" }));

    expect(await screen.findByText("BOOTSHARP 已保存")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/boot/prompts/bootsharp", expect.objectContaining({ method: "PUT" }));
  });

  it("修改工作目录时提交 cwd 并展示 .pi 迁移边界", async () => {
    const profile = {
      version: 1 as const,
      id: "workspace",
      name: "工作区 Agent",
      avatar: { kind: "initial" as const, value: "工" },
      description: "",
      status: "active" as const,
      cwd: "/data/workspace/agents/workspace",
      instructions: { role: "", behavior: "", rules: "", user: "" },
      allowedTools: ["read"],
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/models") return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (String(input).includes("/resources")) return new Response(JSON.stringify({ resources: [], tools: [] }), { status: 200 });
      const patch = init?.method === "PATCH" ? JSON.parse(String(init.body)) as { cwd: string } : undefined;
      return new Response(JSON.stringify({
        profile: patch ? { ...profile, cwd: patch.cwd } : profile,
        revision: patch ? "r2" : "r1",
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="workspace" onNavigate={vi.fn()} />);

    fireEvent.change(await screen.findByRole("textbox", { name: "工作目录" }), {
      target: { value: "/data/projects/new-workspace" },
    });
    expect(screen.getByText(/其他项目文件留在原目录/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存更改" }));

    expect(await screen.findByText("已保存")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/workspace", expect.objectContaining({
      method: "PATCH",
      body: expect.stringContaining('"cwd":"/data/projects/new-workspace"'),
    }));
  });

  it("可以上传本地图片作为头像", async () => {
    const profile = {
      version: 1 as const, id: "avatar", name: "头像 Agent", avatar: { kind: "initial" as const, value: "头" },
      description: "", status: "active" as const, cwd: "/data/workspace/agents/avatar",
      instructions: { role: "", behavior: "", rules: "", user: "" }, allowedTools: [],
      createdAt: "2026-08-05T00:00:00.000Z", updatedAt: "2026-08-05T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify({
      profile: String(input).includes("/avatar?") ? { ...profile, avatar: { kind: "image", revision: "img1", mediaType: "image/png" } } : profile,
      revision: String(input).includes("/avatar?") ? "r2" : "r1",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<AgentDetailPage agentId="avatar" onNavigate={vi.fn()} />);
    await screen.findByText("头像 Agent");

    const file = new File([new Uint8Array([137, 80, 78, 71])], "avatar.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("上传头像图片"), { target: { files: [file] } });

    expect(await screen.findByRole("img", { name: "头像 Agent 的头像" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/agents/avatar/avatar?revision=r1", expect.objectContaining({ method: "POST" }));
  });
});
