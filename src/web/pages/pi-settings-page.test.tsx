import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { PiSettingsPage } from "./pi-settings-page";

function renderPiSettingsPage() {
  return render(<ErrorToastProvider><ApiTaskProvider onAuthenticationRequired={vi.fn()}><PiSettingsPage /></ApiTaskProvider></ErrorToastProvider>);
}

describe("PiSettingsPage", () => {
  it("展示七组设置并在 Agent 作用域呈现继承状态", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [{ profile: { id: "agent-a", name: "Agent A" }, revision: "a1" }] }), { status: 200 });
      if (String(input) === "/api/v1/models") return new Response(JSON.stringify({ models: [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }] }), { status: 200 });
      if (String(input).includes("/agents/agent-a/settings")) return new Response(JSON.stringify({ revision: "r2", own: { retry: { maxRetries: 2 } }, inherited: { defaultProvider: "openai", defaultModel: "gpt-4o", retry: { maxRetries: 5 } }, effective: { defaultProvider: "openai", defaultModel: "gpt-4o", retry: { maxRetries: 2 } }, diagnostics: [] }), { status: 200 });
      return new Response(JSON.stringify({ revision: "r1", own: { defaultProvider: "openai", defaultModel: "gpt-4o" }, effective: { defaultProvider: "openai", defaultModel: "gpt-4o" }, diagnostics: [] }), { status: 200 });
    }));
    renderPiSettingsPage();

    expect(await screen.findByRole("heading", { name: "运行设置" })).toBeInTheDocument();
    expect(screen.getAllByRole("option", { name: "核心默认值" }).length).toBeGreaterThan(0);
    for (const title of ["模型与推理", "压缩", "重试", "消息传输", "图片", "Shell 与网络", "资源路径"]) expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText("theme")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("设置作用域"), { target: { value: "agent" } });
    expect(await screen.findByText("当前继承：openai / gpt-4o")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { name: "使用全局默认值" }).length).toBeGreaterThan(0);
    expect(screen.getByText("最终有效值")).toBeInTheDocument();
  });

  it("revision 冲突时展示差异并只允许重新加载或重新应用", async () => {
    let globalReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      if (String(input) === "/api/v1/models") return new Response(JSON.stringify({ models: [] }), { status: 200 });
      if (String(input) === "/api/v1/configuration/global" && init?.method === "PATCH") return new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "配置已变化" } }), { status: 409 });
      globalReads += 1;
      return new Response(JSON.stringify(globalReads === 1
        ? { revision: "r1", own: { retry: { maxRetries: 2 } }, effective: { retry: { maxRetries: 2 } }, diagnostics: [] }
        : { revision: "r2", own: { retry: { maxRetries: 3 } }, effective: { retry: { maxRetries: 3 } }, diagnostics: [] }), { status: 200 });
    }));
    renderPiSettingsPage();
    const input = await screen.findByLabelText("最大重试次数");
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    expect(await screen.findByText("配置已在磁盘上发生变化")).toBeInTheDocument();
    expect(screen.getByText("retry.maxRetries")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /覆盖/u })).not.toBeInTheDocument();
  });

  it("通过一个下拉框选择默认 Provider 和模型，并在保存时成对提交", async () => {
    let saved: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/v1/agents") return new Response(JSON.stringify({ agents: [] }), { status: 200 });
      if (String(input) === "/api/v1/models") return new Response(JSON.stringify({ models: [
        { provider: "provider-a", id: "model-a", name: "模型 A" },
        { provider: "provider-b", id: "model-b", name: "模型 B" },
      ] }), { status: 200 });
      if (String(input) === "/api/v1/configuration/global" && init?.method === "PATCH") {
        saved = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ revision: "r2", own: saved.set, effective: saved.set, diagnostics: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ revision: "r1", own: { defaultProvider: "provider-a", defaultModel: "model-a" }, effective: { defaultProvider: "provider-a", defaultModel: "model-a" }, diagnostics: [] }), { status: 200 });
    }));
    renderPiSettingsPage();

    const modelSelector = await screen.findByRole("combobox", { name: "默认模型" });
    expect(screen.queryByLabelText("默认 Provider")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "provider-a / 模型 A" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "provider-b / 模型 B" })).toBeInTheDocument();

    fireEvent.change(modelSelector, { target: { value: JSON.stringify(["provider-b", "model-b"]) } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));

    await screen.findByText("设置已保存");
    expect(saved).toMatchObject({
      revision: "r1",
      set: { defaultProvider: "provider-b", defaultModel: "model-b" },
    });
  });

  it("运行设置加载发生意外错误时显示全局 Toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("settings network secret"); }));
    renderPiSettingsPage();

    expect(await screen.findByRole("group", { name: "操作未完成" })).toBeInTheDocument();
    expect(screen.queryByText("settings network secret")).not.toBeInTheDocument();
  });
});
