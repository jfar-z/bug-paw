import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { ProvidersPage } from "./providers-page";

function renderProvidersPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><ProvidersPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("ProvidersPage", () => {
  it("通过应用内对话框改名 Provider 并提交引用迁移", async () => {
    const provider = { name: "Example", baseUrl: "http://localhost:11434", api: "openai-completions", models: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/providers/example/rename") {
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { renamed: provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.click(await screen.findByRole("button", { name: "重命名 Provider" }));
    const dialog = screen.getByRole("dialog", { name: "重命名 Provider" });
    const input = screen.getByLabelText("新的 Provider ID");
    expect(input).toHaveValue("example");
    fireEvent.change(input, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "确认改名" }));

    expect(dialog).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/example/rename", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ id: "renamed", revision: "r1", confirmed: true }),
    })));
    expect(await screen.findByText(/Provider 已改名/u)).toBeInTheDocument();
  });

  it("拖拽 Provider 和模型后保存 Pi 原生顺序", async () => {
    const first = { name: "First", baseUrl: "https://first.example/v1", api: "openai-completions", models: [{ id: "one", name: "One", reasoning: false, thinkingLevelMap: {}, compat: {} }, { id: "two", name: "Two", reasoning: false, thinkingLevelMap: {}, compat: {} }] };
    const second = { name: "Second", baseUrl: "https://second.example/v1", api: "openai-completions", models: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/providers/order") {
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { second, first } } }), { status: 200 });
      }
      if (url === "/api/v1/providers/first/models/order") {
        return new Response(JSON.stringify({ revision: "r3", diagnostics: [], value: { providers: { second, first: { ...first, models: [first.models[1], first.models[0]] } } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { first, second } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    const firstProvider = await screen.findByRole("button", { name: "选择或拖动 Provider First 排序" });
    const secondProvider = screen.getByRole("button", { name: "选择或拖动 Provider Second 排序" });
    fireEvent.dragStart(secondProvider);
    fireEvent.dragOver(firstProvider);
    fireEvent.drop(firstProvider);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/order", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ providerIds: ["second", "first"], revision: "r1" }),
    })));

    fireEvent.click(screen.getByRole("button", { name: "选择或拖动 Provider First 排序" }));
    const firstModel = await screen.findByRole("button", { name: "选择或拖动模型 One 排序" });
    const secondModel = screen.getByRole("button", { name: "选择或拖动模型 Two 排序" });
    fireEvent.dragStart(secondModel);
    fireEvent.dragOver(firstModel);
    fireEvent.drop(firstModel);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/first/models/order", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ modelIds: ["two", "one"], revision: "r2" }),
    })));
  });

  it("可保存模型容量参数并删除已保存模型", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{ id: "reasoner", name: "Reasoner", reasoning: false, thinkingLevelMap: {}, compat: {}, contextWindow: 128000, maxTokens: 8192 }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/providers/example/models/reasoner" && init?.method === "DELETE") {
        return new Response(JSON.stringify({ revision: "r3", diagnostics: [], value: { providers: { example: { ...provider, models: [] } } } }), { status: 200 });
      }
      if (url === "/api/v1/providers/example" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.change(await screen.findByLabelText("上下文窗口"), { target: { value: "200000" } });
    fireEvent.change(screen.getByLabelText("最大返回 Token"), { target: { value: "16000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/example", expect.objectContaining({
      method: "PUT",
      body: expect.stringContaining('"contextWindow":200000'),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/example", expect.objectContaining({
      body: expect.stringContaining('"maxTokens":16000'),
    }));

    fireEvent.click(await screen.findByRole("button", { name: "删除模型" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/example/models/reasoner", expect.objectContaining({ method: "DELETE" }));
  });

  it("使用表单展示 Provider、Headers、思考映射和脱敏凭证状态", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/test")) return new Response(JSON.stringify({
        providerId: "example",
        results: [{ modelId: "reasoner", modelName: "Reasoner", ok: true, durationMs: 12, responsePreview: "OK" }],
      }), { status: 200 });
      if (init?.method === "PUT") return new Response(JSON.stringify({ revision: "r2", value: { providers: {} }, diagnostics: [] }), { status: 200 });
      return new Response(JSON.stringify({
        revision: "r1", credentialRevision: "c1", credentials: [{ providerId: "example", type: "api_key", configured: true }], diagnostics: [],
        value: { providers: { example: { name: "Example", baseUrl: "http://localhost:11434", api: "openai-completions", headers: { "X-Test": "value" }, models: [{ id: "reasoner", name: "Reasoner", reasoning: true, thinkingLevelMap: { max: null }, compat: {} }] } } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    expect(await screen.findByDisplayValue("Example")).toBeInTheDocument();
    expect(screen.queryByLabelText("Provider 模板")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("X-Test")).toBeInTheDocument();
    expect(screen.getByText("Reasoner")).toBeInTheDocument();
    expect(screen.getByText("已配置 · 点击小眼睛查看")).toBeInTheDocument();
    expect(screen.getByLabelText("max 映射")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "测试当前模型" }));
    expect(await screen.findByText(/Reasoner.*成功.*12 ms/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/example/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ scope: "current", modelId: "reasoner" }),
    }));
    expect(screen.getByText("高级 JSON")).toBeInTheDocument();
  });

  it("保存 Provider 后立即允许测试已保存的当前模型", async () => {
    const provider = {
      name: "Example",
      baseUrl: "http://localhost:11434",
      api: "openai-completions",
      authHeader: true,
      models: [{ id: "reasoner", name: "Reasoner", reasoning: false, thinkingLevelMap: {}, compat: {} }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/test")) return new Response(JSON.stringify({ providerId: "example", results: [] }), { status: 200 });
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({
        revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    const name = await screen.findByDisplayValue("Example");
    fireEvent.change(name, { target: { value: "Example Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

    const testCurrent = await screen.findByRole("button", { name: "测试当前模型" });
    expect(testCurrent).toBeEnabled();
  });

  it("空 Headers 与缺失 Headers 等价，不会阻止已保存 Provider 测试", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      credentialRevision: "c1",
      credentials: [],
      diagnostics: [],
      value: {
        providers: {
          "provider-2": {
            name: "Provider 2",
            baseUrl: "https://api.example.com/v1",
            api: "openai-responses",
            authHeader: true,
            headers: {},
            models: [{ id: "model-a", name: "模型 A", reasoning: false, thinkingLevelMap: {}, compat: {} }],
          },
        },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    expect(await screen.findByRole("button", { name: "测试当前模型" })).toBeEnabled();
    expect(screen.queryByText("请先保存 Provider 后测试")).not.toBeInTheDocument();
  });

  it("在第 01 步显示只写 API Key，在第 02 步发现并只导入草稿", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      authHeader: true,
      models: [{ id: "existing", name: "Existing", reasoning: false, thinkingLevelMap: {}, compat: {} }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/discover-models")) {
        return new Response(JSON.stringify({
          providerId: "example",
          models: [
            { id: "existing", name: "existing", exists: true },
            { id: "gpt-new", name: "gpt-new", exists: false },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        revision: "r1",
        credentialRevision: "c1",
        credentials: [{ providerId: "example", type: "api_key", configured: true }],
        diagnostics: [],
        value: { providers: { example: provider } },
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    const apiKey = await screen.findByLabelText("API Key");
    expect(apiKey.closest(".configuration-form-card")?.textContent).toContain("01");
    fireEvent.click(screen.getByRole("button", { name: "发现模型" }));
    expect(await screen.findByLabelText("选择 gpt-new")).toBeChecked();
    expect(screen.getByLabelText("选择 existing")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "导入所选模型" }));

    expect(screen.getByText("gpt-new")).toBeInTheDocument();
    expect(screen.getByLabelText("模型 ID")).toHaveValue("gpt-new");
    expect(fetchMock.mock.calls.some(([input]) => String(input) === "/api/v1/providers/example")).toBe(false);
  });

  it("点击已配置 Provider 的小眼睛后按需读取并显示 API Key", async () => {
    const provider = { name: "Example", baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/providers/example/credential") {
        return new Response(JSON.stringify({ apiKey: "provider-secret" }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [{ providerId: "example", type: "api_key", configured: true }], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    await screen.findByLabelText("API Key");
    fireEvent.click(screen.getByRole("button", { name: "显示API Key" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/example/credential", expect.anything()));
    expect(screen.getByLabelText("API Key")).toHaveAttribute("type", "text");
    expect(screen.getByLabelText("API Key")).toHaveValue("provider-secret");
  });

  it("Provider 未保存或草稿有修改时禁用模型发现", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      credentialRevision: "c1",
      credentials: [],
      diagnostics: [],
      value: {
        providers: {
          example: {
            name: "Example",
            baseUrl: "https://api.example.com/v1",
            api: "openai-completions",
            models: [{ id: "model-a", name: "模型 A", reasoning: false, thinkingLevelMap: {}, compat: {} }],
          },
        },
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    expect(await screen.findByRole("button", { name: "发现模型" })).toBeEnabled();
    fireEvent.change(screen.getByDisplayValue("Example"), { target: { value: "Changed" } });
    expect(screen.getByRole("button", { name: "发现模型" })).toBeDisabled();
  });

  it("打开并取消新建 Provider 弹窗时保留当前已选配置", async () => {
    const provider = { name: "Example", baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      credentialRevision: "c1",
      credentials: [],
      diagnostics: [],
      value: { providers: { example: provider } },
    }), { status: 200 })));
    renderProvidersPage();

    expect(await screen.findByDisplayValue("Example")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建 Provider" }));

    expect(screen.getByRole("dialog", { name: "新建 Provider" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("Example")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "新建 Provider" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Example")).toBeInTheDocument();
  });

  it("没有已保存 Provider 时不展示无法保存的 API Key 输入", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      credentialRevision: "c1",
      credentials: [],
      diagnostics: [],
      value: { providers: {} },
    }), { status: 200 })));
    renderProvidersPage();

    expect(await screen.findByText("尚未创建 Provider")).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "新建 Provider" }));
    expect(screen.getByRole("dialog", { name: "新建 Provider" })).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
  });

  it("创建成功后自动选中新 Provider 并可立即保存 API Key", async () => {
    const example = { name: "Example", baseUrl: "https://api.example.com/v1", api: "openai-completions", models: [] };
    const created = { name: "Created", baseUrl: "https://created.example.test/v1", api: "openai-completions", authHeader: true, models: [] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/v1/providers" && init?.method === "POST") {
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example, created } } }), { status: 200 });
      }
      if (url === "/api/v1/providers/created/credential" && init?.method === "PUT") {
        return new Response(JSON.stringify({ credentialRevision: "c2", status: { providerId: "created", type: "api_key", configured: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.click(await screen.findByRole("button", { name: "新建 Provider" }));
    const dialog = screen.getByRole("dialog", { name: "新建 Provider" });
    fireEvent.change(within(dialog).getByLabelText("Provider ID"), { target: { value: "created" } });
    fireEvent.change(within(dialog).getByLabelText("显示名称"), { target: { value: "Created" } });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://created.example.test/v1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "创建 Provider" }));

    expect(await screen.findByText("Provider 已创建，请继续配置 API Key")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "新建 Provider" })).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Created")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "test-provider-key" } });
    fireEvent.click(screen.getByRole("button", { name: "保存凭证" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers/created/credential", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ revision: "c1", apiKey: "test-provider-key" }),
    })));
  });

  it("保存兼容字段并在自动模式移除该字段，同时保留高级字段", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{
        id: "reasoner",
        name: "Reasoner",
        reasoning: true,
        thinkingLevelMap: {},
        compat: { customFutureOption: "keep" },
      }],
    };
    const savedBodies: Array<{ provider: typeof provider }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/providers/example" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        savedBodies.push(body);
        return new Response(JSON.stringify({ revision: `r${savedBodies.length + 1}`, diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.change(await screen.findByLabelText("推理内容转文本"), { target: { value: "on" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies.at(-1)?.provider.models[0].compat).toMatchObject({ requiresThinkingAsText: true, customFutureOption: "keep" });

    fireEvent.change(screen.getByLabelText("推理内容转文本"), { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));
    await waitFor(() => expect(savedBodies).toHaveLength(2));
    expect(savedBodies.at(-1)?.provider.models[0].compat).not.toHaveProperty("requiresThinkingAsText");
    expect(savedBodies.at(-1)?.provider.models[0].compat).toMatchObject({ customFutureOption: "keep" });
  });

  it("启用图片输入后按 Pi input 字段保存模型能力", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{ id: "vision", name: "Vision", reasoning: false, thinkingLevelMap: {}, compat: {}, input: ["text"] }],
    };
    const savedBodies: Array<{ provider: typeof provider }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/providers/example" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        savedBodies.push(body);
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    expect(await screen.findByLabelText("文本输入")).toBeChecked();
    expect(screen.getByLabelText("文本输入")).toBeDisabled();
    expect(screen.getByLabelText("图片输入")).not.toBeChecked();
    fireEvent.click(screen.getByLabelText("图片输入"));
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0].provider.models[0].input).toEqual(["text", "image"]);
  });

  it("关闭已启用的图片输入后仅保存文本输入", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{ id: "vision", name: "Vision", reasoning: false, thinkingLevelMap: {}, compat: {}, input: ["text", "image"] }],
    };
    const savedBodies: Array<{ provider: typeof provider }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/providers/example" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        savedBodies.push(body);
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    expect(await screen.findByLabelText("图片输入")).toBeChecked();
    fireEvent.click(screen.getByLabelText("图片输入"));
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0].provider.models[0].input).toEqual(["text"]);
  });

  it("仅为推理模型展示思考协议，并预览 Qwen Chat Template 参数", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{ id: "reasoner", name: "Reasoner", reasoning: false, thinkingLevelMap: {}, compat: {} }],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      revision: "r1",
      credentialRevision: "c1",
      credentials: [],
      diagnostics: [],
      value: { providers: { example: provider } },
    }), { status: 200 })));
    renderProvidersPage();

    const reasoning = await screen.findByRole("checkbox", { name: "推理模型" });
    expect(screen.queryByLabelText("思考协议")).not.toBeInTheDocument();

    fireEvent.click(reasoning);
    fireEvent.change(screen.getByLabelText("思考协议"), { target: { value: "qwen-chat-template" } });

    expect(screen.getByText("开启思考")).toBeInTheDocument();
    expect(screen.getByText("关闭思考")).toBeInTheDocument();
    expect(screen.getAllByText(/chat_template_kwargs/u)).toHaveLength(2);
    expect(screen.getByText(/"enable_thinking": true/u)).toBeInTheDocument();
    expect(screen.getByText(/"enable_thinking": false/u)).toBeInTheDocument();
  });

  it("思考协议切回自动时仅移除 thinkingFormat", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{
        id: "reasoner",
        name: "Reasoner",
        reasoning: true,
        thinkingLevelMap: {},
        compat: { thinkingFormat: "qwen", customFutureOption: "keep" },
      }],
    };
    const savedBodies: Array<{ provider: typeof provider }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/providers/example" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        savedBodies.push(body);
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.change(await screen.findByLabelText("思考协议"), { target: { value: "auto" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0].provider.models[0].compat).toEqual({ customFutureOption: "keep" });
  });

  it("保存思考协议时保留其他兼容字段", async () => {
    const provider = {
      name: "Example",
      baseUrl: "https://api.example.com/v1",
      api: "openai-completions",
      models: [{
        id: "reasoner",
        name: "Reasoner",
        reasoning: true,
        thinkingLevelMap: {},
        compat: { customFutureOption: "keep" },
      }],
    };
    const savedBodies: Array<{ provider: typeof provider }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/providers/example" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as { provider: typeof provider };
        savedBodies.push(body);
        return new Response(JSON.stringify({ revision: "r2", diagnostics: [], value: { providers: { example: body.provider } } }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", credentialRevision: "c1", credentials: [], diagnostics: [], value: { providers: { example: provider } } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderProvidersPage();

    fireEvent.change(await screen.findByLabelText("思考协议"), { target: { value: "qwen-chat-template" } });
    fireEvent.click(screen.getByRole("button", { name: "保存 Provider" }));

    await waitFor(() => expect(savedBodies).toHaveLength(1));
    expect(savedBodies[0].provider.models[0].compat).toEqual({
      customFutureOption: "keep",
      thinkingFormat: "qwen-chat-template",
    });
  });

  it("Provider 加载发生意外错误时显示全局 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("provider network secret"); }));
    renderProvidersPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("provider network secret")).not.toBeInTheDocument();
  });
});
