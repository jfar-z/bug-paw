import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ModelConfigDocument } from "../../../shared/configuration-contracts";
import { ApiTaskProvider } from "../../api-task-provider";
import { ErrorToastProvider } from "../../error-toast-provider";
import { ProviderCreateDialog } from "./provider-create-dialog";

const createdDocument: ModelConfigDocument = {
  revision: "r2",
  diagnostics: [],
  value: {
    providers: {
      "local-llm": {
        name: "本地模型",
        baseUrl: "http://localhost:11434/v1",
        api: "openai-completions",
        authHeader: false,
        models: [],
      },
    },
  },
};

describe("ProviderCreateDialog", () => {
  it("只显示创建 Provider 所需的四个字段，取消时不提交", () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(screen.getByRole("dialog", { name: "新建 Provider" })).toBeInTheDocument();
    expect(screen.getByLabelText("Provider ID")).toBeInTheDocument();
    expect(screen.getByLabelText("显示名称")).toBeInTheDocument();
    expect(screen.getByLabelText("Provider 模板")).toBeInTheDocument();
    expect(screen.getByLabelText("Base URL")).toBeInTheDocument();
    expect(screen.queryByLabelText("API Key")).not.toBeInTheDocument();
    expect(screen.queryByText("Headers")).not.toBeInTheDocument();
    expect(screen.queryByText("添加模型")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("限制弹窗高度并允许矮屏设备滚动到操作按钮", () => {
    renderDialog();

    expect(screen.getByRole("dialog", { name: "新建 Provider" })).toHaveStyle({
      maxHeight: "calc(100dvh - 40px)",
      overflowY: "auto",
    });
  });

  it("按模板更新地址并使用默认协议与认证设置创建 Provider", async () => {
    const fetchMock = installFetch();
    const onCreated = vi.fn();
    renderDialog({ onCreated });

    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "local-llm" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "本地模型" } });
    fireEvent.change(screen.getByLabelText("Provider 模板"), { target: { value: "ollama" } });

    expect(screen.getByLabelText("Base URL")).toHaveValue("http://localhost:11434/v1");
    fireEvent.click(screen.getByRole("button", { name: "创建 Provider" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        id: "local-llm",
        revision: "r1",
        provider: {
          name: "本地模型",
          baseUrl: "http://localhost:11434/v1",
          api: "openai-completions",
          authHeader: false,
          models: [],
        },
      }),
    })));
    expect(onCreated).toHaveBeenCalledWith("local-llm", createdDocument);
  });

  it("自定义模板使用通用默认配置和用户填写的 Base URL", async () => {
    const fetchMock = installFetch();
    renderDialog();

    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "custom-provider" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "自定义模型" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://models.example.test/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Provider" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/v1/providers", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        id: "custom-provider",
        revision: "r1",
        provider: {
          name: "自定义模型",
          baseUrl: "https://models.example.test/v1",
          api: "openai-completions",
          authHeader: true,
          models: [],
        },
      }),
    })));
  });

  it("ID 无效时说明规则并禁止提交", () => {
    renderDialog();

    expect(screen.getByRole("button", { name: "创建 Provider" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "-invalid" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "无效渠道" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://models.example.test/v1" } });

    expect(within(screen.getByRole("dialog", { name: "新建 Provider" })).getByRole("alert")).toHaveTextContent("ID 只能使用字母、数字、点、下划线或连字符");
    expect(screen.getByRole("button", { name: "创建 Provider" })).toBeDisabled();
  });

  it("Base URL 无效时说明规则并禁止提交", () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "invalid-url" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "地址无效" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "not-a-url" } });

    expect(within(screen.getByRole("dialog", { name: "新建 Provider" })).getByRole("alert")).toHaveTextContent("Base URL 必须是有效的 HTTP 或 HTTPS 地址");
    expect(screen.getByRole("button", { name: "创建 Provider" })).toBeDisabled();
  });

  it.each([
    ["PROVIDER_ID_EXISTS", "Provider ID 已存在", 409],
    ["VERSION_CONFLICT", "配置文件已被修改", 409],
    ["MODEL_SCHEMA_INVALID", "模型配置未通过 Pi 校验", 422],
  ])("%s 时保留弹窗和创建草稿", async (code, message, status) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { code, message } }, status)));
    const onCreated = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onCreated, onClose });

    fireEvent.change(screen.getByLabelText("Provider ID"), { target: { value: "draft-provider" } });
    fireEvent.change(screen.getByLabelText("显示名称"), { target: { value: "草稿渠道" } });
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://draft.example.test/v1" } });
    fireEvent.click(screen.getByRole("button", { name: "创建 Provider" }));

    const dialog = screen.getByRole("dialog", { name: "新建 Provider" });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(message);
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText("Provider ID")).toHaveValue("draft-provider");
    expect(screen.getByLabelText("显示名称")).toHaveValue("草稿渠道");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://draft.example.test/v1");
    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

/** 使用生产环境一致的错误分发上下文渲染 Provider 创建弹窗。 */
function renderDialog(overrides: Partial<React.ComponentProps<typeof ProviderCreateDialog>> = {}) {
  const props: React.ComponentProps<typeof ProviderCreateDialog> = {
    revision: "r1",
    online: true,
    onCreated: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><ProviderCreateDialog {...props} /></ApiTaskProvider></ErrorToastProvider>);
}

/** 模拟创建接口返回不含凭证元数据的模型配置文档。 */
function installFetch() {
  const fetchMock = vi.fn(async () => json(createdDocument));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}
