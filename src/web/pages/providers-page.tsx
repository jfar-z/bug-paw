import { Check, GripVertical, PencilLine, Plus, Save, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderEditorModel, ProviderTemplate } from "../../shared/configuration-contracts";
import { api, type DiscoveredModel, type ModelConnectionTestItem, type ModelConnectionTestRequest, type ProvidersDocument } from "../api";
import { KeyValueEditor, type KeyValueRow } from "../components/configuration/key-value-editor";
import { ProviderRenameDialog } from "../components/configuration/provider-rename-dialog";
import { ThinkingLevelMapEditor } from "../components/configuration/thinking-level-map-editor";
import { useOnlineStatus } from "../use-online-status";

interface ProviderNode extends Record<string, unknown> {
  name?: string;
  baseUrl?: string;
  api?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ProviderEditorModel[];
}

type CompatBooleanKey =
  | "supportsDeveloperRole"
  | "supportsReasoningEffort"
  | "supportsUsageInStreaming"
  | "supportsStore"
  | "requiresToolResultName"
  | "requiresAssistantAfterToolResult"
  | "requiresThinkingAsText"
  | "requiresReasoningContentOnAssistantMessages";

const compatBooleanFields: Array<{ key: CompatBooleanKey; label: string; help?: string }> = [
  { key: "supportsDeveloperRole", label: "支持 developer 角色" },
  { key: "supportsReasoningEffort", label: "支持推理强度" },
  { key: "supportsUsageInStreaming", label: "流式响应支持用量" },
  { key: "supportsStore", label: "支持服务端存储" },
  { key: "requiresToolResultName", label: "工具结果需要名称" },
  { key: "requiresAssistantAfterToolResult", label: "工具结果后需要 assistant" },
  { key: "requiresThinkingAsText", label: "推理内容转文本", help: "llama.cpp/Qwen 续聊时可避免回放不兼容的 reasoning_content。" },
  { key: "requiresReasoningContentOnAssistantMessages", label: "Assistant 消息需要 reasoning_content" },
];

const templateDefaults: Record<ProviderTemplate, Partial<ProviderNode>> = {
  "openai-compatible": { api: "openai-completions", baseUrl: "https://api.example.com/v1", authHeader: true },
  ollama: { api: "openai-completions", baseUrl: "http://localhost:11434/v1", authHeader: false },
  vllm: { api: "openai-completions", baseUrl: "http://localhost:8000/v1", authHeader: false },
  "lm-studio": { api: "openai-completions", baseUrl: "http://localhost:1234/v1", authHeader: false },
  custom: {},
};

const discoveryApis = new Set(["openai-completions", "openai-responses"]);

function providerMap(document: ProvidersDocument | undefined): Record<string, ProviderNode> {
  const providers = document?.value.providers;
  return typeof providers === "object" && providers !== null ? providers as Record<string, ProviderNode> : {};
}

function rowsFromHeaders(headers: Record<string, string> | undefined): KeyValueRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }));
}

function headersFromRows(rows: KeyValueRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));
}

function savedProviderDraft(draft: ProviderNode, headers: KeyValueRow[]): ProviderNode {
  const next = { ...draft };
  const values = headersFromRows(headers);
  if (Object.keys(values).length > 0) next.headers = values;
  else delete next.headers;
  return next;
}

function comparableProvider(provider: ProviderNode): ProviderNode {
  const next = { ...provider };
  if (next.headers && Object.keys(next.headers).length === 0) {
    delete next.headers;
  }
  return next;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

function emptyModel(): ProviderEditorModel {
  return { id: "new-model", name: "新模型", reasoning: false, thinkingLevelMap: {}, compat: {}, input: ["text"], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
}

/**
 * 将来源 ID 插入目标 ID 前方，生成一份不修改原数组的新顺序。
 */
function moveId(ids: string[], sourceId: string, targetId: string): string[] {
  if (sourceId === targetId) return ids;
  const remaining = ids.filter((id) => id !== sourceId);
  const targetIndex = remaining.indexOf(targetId);
  return targetIndex < 0 ? ids : [...remaining.slice(0, targetIndex), sourceId, ...remaining.slice(targetIndex)];
}

/**
 * 规范化模型输入能力，确保 Pi 始终能接收文本消息。
 */
function modelInput(model: ProviderEditorModel | undefined): Array<"text" | "image"> {
  return model?.input?.includes("image") ? ["text", "image"] : ["text"];
}

/**
 * 以普通表单为主编辑 Provider、模型和只写凭证，高级 JSON 仅作为兜底。
 */
export function ProvidersPage() {
  const online = useOnlineStatus();
  const [document, setDocument] = useState<ProvidersDocument>();
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<ProviderNode>({});
  const [template, setTemplate] = useState<ProviderTemplate>("custom");
  const [headers, setHeaders] = useState<KeyValueRow[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [testResults, setTestResults] = useState<ModelConnectionTestItem[]>([]);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModel[]>([]);
  const [selectedDiscoveredIds, setSelectedDiscoveredIds] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<false | "saving" | "testing" | "discovering">(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [draggingProviderId, setDraggingProviderId] = useState<string>();
  const [draggingModelId, setDraggingModelId] = useState<string>();

  const providers = providerMap(document);
  const ids = Object.keys(providers);
  const selectedModel = draft.models?.[selectedModelIndex];
  const credential = document?.credentials.find((item) => item.providerId === selectedId);
  const providerDraft = useMemo(() => savedProviderDraft(draft, headers), [draft, headers]);
  const savedProvider = providers[selectedId];
  const isDirty = !savedProvider
    || stableJson(comparableProvider(savedProvider)) !== stableJson(comparableProvider(providerDraft));
  const testing = busy === "testing";
  const testDisabled = !online || busy !== false || isDirty;
  const canTestCurrent = !testDisabled && Boolean(selectedModel?.id);
  const canTestAll = !testDisabled && (draft.models?.length ?? 0) > 0;
  const canDiscover = ids.includes(selectedId)
    && !isDirty
    && online
    && busy === false
    && Boolean(draft.baseUrl?.trim())
    && discoveryApis.has(draft.api ?? "");
  const advancedJson = useMemo(() => JSON.stringify({ ...draft, headers: headersFromRows(headers) }, null, 2), [draft, headers]);

  function selectProvider(id: string, source = providers) {
    const node = structuredClone(source[id] ?? {});
    setSelectedId(id);
    setDraft(node);
    setHeaders(rowsFromHeaders(node.headers));
    setSelectedModelIndex(0);
    setTemplate("custom");
    setTestResults([]);
    setDiscoveredModels([]);
    setSelectedDiscoveredIds(new Set());
    setNotice("");
  }

  useEffect(() => {
    let active = true;
    api.listProviders().then((loaded) => {
      if (!active) return;
      setDocument(loaded);
      const map = providerMap(loaded);
      const first = Object.keys(map)[0];
      if (first) selectProvider(first, map);
    }).catch((requestError) => setError(requestError instanceof Error ? requestError.message : "Provider 加载失败"));
    return () => { active = false; };
  }, []);

  function updateModel(patch: Partial<ProviderEditorModel>) {
    setDraft((current) => ({ ...current, models: (current.models ?? []).map((model, index) => index === selectedModelIndex ? { ...model, ...patch } : model) }));
  }

  /**
   * 根据图片开关更新当前模型的 Pi 输入能力声明。
   */
  function setImageInput(enabled: boolean) {
    updateModel({ input: enabled ? ["text", "image"] : ["text"] });
  }

  /**
   * 从表单值读取正整数；空值表示让 Pi 使用其默认值。
   */
  function updateModelCapacity(field: "contextWindow" | "maxTokens", value: string) {
    const parsed = Number(value);
    updateModel({ [field]: Number.isInteger(parsed) && parsed > 0 ? parsed : undefined });
  }

  /**
   * 更新当前模型的兼容配置；自动模式将字段交回 Pi 推断。
   */
  function updateCompatValue(key: string, value: string) {
    const compat = { ...(selectedModel?.compat ?? {}) };
    if (value === "auto") delete compat[key];
    else compat[key] = value === "on";
    updateModel({ compat });
  }

  /**
   * 更新当前模型的枚举兼容配置；自动模式移除原有覆盖值。
   */
  function updateCompatOption(key: "maxTokensField" | "thinkingFormat", value: string) {
    const compat = { ...(selectedModel?.compat ?? {}) };
    if (value === "auto") delete compat[key];
    else compat[key] = value;
    updateModel({ compat });
  }

  function compatBooleanValue(key: CompatBooleanKey): "auto" | "on" | "off" {
    const value = selectedModel?.compat?.[key];
    return value === true ? "on" : value === false ? "off" : "auto";
  }

  /**
   * 删除当前模型草稿或已保存模型，并保持 Provider 列表与 revision 同步。
   */
  async function deleteSelectedModel() {
    if (!document || !selectedId || !selectedModel) return;
    const savedModels = savedProvider?.models ?? [];
    const saved = savedModels.some((model) => model.id === selectedModel.id);
    if (!saved) {
      setDraft((current) => ({ ...current, models: (current.models ?? []).filter((_, index) => index !== selectedModelIndex) }));
      setSelectedModelIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (isDirty) {
      setError("请先保存 Provider 更改后再删除已保存模型。");
      return;
    }
    setBusy("saving");
    setError("");
    try {
      const updated = await api.removeProviderModel(selectedId, selectedModel.id, document.revision);
      setDocument({ ...document, ...updated });
      const updatedProviders = providerMap({ ...document, ...updated });
      selectProvider(selectedId, updatedProviders);
      setNotice("模型已删除");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "删除模型失败");
    } finally {
      setBusy(false);
    }
  }

  async function saveProvider() {
    if (!document || !selectedId) return;
    if (!validProviderId(selectedId)) {
      setError("Provider ID 只能使用字母、数字、点、下划线或连字符，且不能以符号开头或结尾。");
      return;
    }
    const invalidCapacity = (draft.models ?? []).some((model) => model.contextWindow !== undefined
      && model.maxTokens !== undefined
      && model.contextWindow < model.maxTokens);
    if (invalidCapacity) {
      setError("上下文窗口不能小于最大返回 Token。");
      return;
    }
    setBusy("saving"); setError(""); setNotice("");
    try {
      const updated = savedProvider
        ? await api.saveProvider(selectedId, document.revision, providerDraft)
        : await api.createProvider(selectedId, document.revision, providerDraft);
      setDocument({ ...document, ...updated });
      const updatedProviders = providerMap({ ...document, ...updated });
      selectProvider(selectedId, updatedProviders);
      setDiscoveredModels([]);
      setSelectedDiscoveredIds(new Set());
      setNotice("Provider 已保存；请到系统诊断刷新核心配置后生效。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存失败");
    } finally { setBusy(false); }
  }

  async function saveCredential() {
    if (!document || !selectedId || !apiKey) return;
    setBusy("saving"); setError("");
    try {
      const result = await api.saveProviderCredential(selectedId, document.credentialRevision, apiKey);
      setDocument({ ...document, credentialRevision: result.credentialRevision, credentials: [...document.credentials.filter((item) => item.providerId !== selectedId), result.status] });
      setApiKey(""); setNotice("凭证已替换，明文未回显");
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : "凭证保存失败"); }
    finally { setBusy(false); }
  }

  async function removeCredential() {
    if (!document || !selectedId) return;
    setBusy("saving"); setError("");
    try {
      const result = await api.removeProviderCredential(selectedId, document.credentialRevision);
      setDocument({ ...document, credentialRevision: result.credentialRevision, credentials: document.credentials.filter((item) => item.providerId !== selectedId) });
      setNotice("凭证已删除");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "凭证删除失败");
    } finally {
      setBusy(false);
    }
  }

  async function renameProvider(targetId: string) {
    if (!document || !savedProvider || !selectedId) return;
    if (!validProviderId(targetId)) {
      setError("Provider ID 格式无效。");
      return;
    }
    setBusy("saving"); setError(""); setNotice("");
    try {
      const updated = await api.renameProvider(selectedId, targetId, document.revision);
      setDocument({ ...document, ...updated });
      selectProvider(targetId, providerMap({ ...document, ...updated }));
      setRenameOpen(false);
      setNotice("Provider 已改名，引用已迁移；请到系统诊断刷新核心配置后生效。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "改名失败");
    } finally {
      setBusy(false);
    }
  }

  async function discoverModels() {
    if (!selectedId || !canDiscover) return;
    setBusy("discovering"); setError(""); setNotice("");
    setDiscoveredModels([]); setSelectedDiscoveredIds(new Set());
    try {
      const result = await api.discoverProviderModels(selectedId);
      setDiscoveredModels(result.models);
      setSelectedDiscoveredIds(new Set(result.models.filter((model) => !model.exists).map((model) => model.id)));
      setNotice(`已发现 ${result.models.length} 个模型`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "模型发现失败");
    } finally {
      setBusy(false);
    }
  }

  function toggleDiscoveredModel(modelId: string, checked: boolean) {
    setSelectedDiscoveredIds((current) => {
      const next = new Set(current);
      if (checked) next.add(modelId);
      else next.delete(modelId);
      return next;
    });
  }

  function importDiscoveredModels() {
    const existingIds = new Set((draft.models ?? []).map((model) => model.id));
    const imported = discoveredModels
      .filter((model) => !model.exists && selectedDiscoveredIds.has(model.id) && !existingIds.has(model.id))
      .map((model) => ({ ...emptyModel(), id: model.id, name: model.name }));
    if (imported.length === 0) return;
    setDraft((current) => ({ ...current, models: [...(current.models ?? []), ...imported] }));
    setSelectedModelIndex((draft.models ?? []).length);
    setDiscoveredModels([]);
    setSelectedDiscoveredIds(new Set());
    setNotice(`已导入 ${imported.length} 个模型草稿，请保存 Provider 生效`);
  }

  async function testConnection(request: ModelConnectionTestRequest) {
    if (!selectedId || testDisabled) return;
    setBusy("testing");
    setError("");
    setTestResults([]);
    try {
      setTestResults((await api.testProvider(selectedId, request)).results);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "连接测试失败");
    } finally {
      setBusy(false);
    }
  }

  /**
   * 保存 Provider 在 Pi models.json 中的原生键顺序。
   */
  async function moveProvider(targetId: string) {
    if (!document || !draggingProviderId || isDirty) {
      if (isDirty) setError("请先保存当前 Provider 修改后再排序。");
      return;
    }
    const nextIds = moveId(ids, draggingProviderId, targetId);
    if (nextIds === ids) return;
    setDraggingProviderId(undefined);
    setError("");
    try {
      const updated = await api.reorderProviders(nextIds, document.revision);
      const nextDocument = { ...document, ...updated };
      setDocument(nextDocument);
      selectProvider(selectedId, providerMap(nextDocument));
      setNotice("Provider 排序已保存；请到系统诊断刷新核心配置后生效。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存 Provider 排序失败");
    }
  }

  /**
   * 保存当前 Provider 内模型在 Pi models.json 中的原生数组顺序。
   */
  async function moveModel(targetId: string) {
    if (!document || !selectedId || !draggingModelId || isDirty) {
      if (isDirty) setError("请先保存当前 Provider 修改后再排序。");
      return;
    }
    const modelIds = (draft.models ?? []).map((model) => model.id);
    const nextIds = moveId(modelIds, draggingModelId, targetId);
    if (nextIds === modelIds) return;
    setDraggingModelId(undefined);
    setError("");
    try {
      const updated = await api.reorderProviderModels(selectedId, nextIds, document.revision);
      const nextDocument = { ...document, ...updated };
      setDocument(nextDocument);
      selectProvider(selectedId, providerMap(nextDocument));
      setNotice("模型排序已保存；请到系统诊断刷新核心配置后生效。");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "保存模型排序失败");
    }
  }

  if (!document) return <div className="configuration-page configuration-state"><p>{error || "正在加载 Provider…"}</p></div>;

  return (
    <div className="configuration-page providers-page">
      {renameOpen && selectedId && savedProvider ? <ProviderRenameDialog currentId={selectedId} busy={busy === "saving"} onCancel={() => setRenameOpen(false)} onConfirm={(targetId) => void renameProvider(targetId)} /> : null}
      <header className="configuration-page__heading configuration-page__heading--actions"><div><span className="configuration-eyebrow">MODEL RUNTIME</span><h1>模型与凭证</h1><p>整理 Provider、模型与凭证，让 BUG 始终知道该用什么能力；凭证只写，保存后不会再次显示。</p><p className="configuration-help">所有配置仅保存到磁盘。请到系统诊断刷新核心配置后，才会应用到运行中的 Agent。</p></div><button type="button" className="configuration-primary-action" disabled={!online || busy !== false} onClick={() => { setSelectedId(""); setDraft({ name: "新 Provider", models: [] }); setHeaders([]); setTestResults([]); setDiscoveredModels([]); setSelectedDiscoveredIds(new Set()); setNotice(""); setError(""); }}><Plus size={16} aria-hidden="true" />新建 Provider</button></header>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      {notice ? <p className="configuration-save-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p> : null}
      <div className="provider-workspace">
        <aside className="provider-list" aria-label="Provider 列表">{ids.map((id) => <button type="button" key={id} className={selectedId === id ? "is-active provider-list__item" : "provider-list__item"} aria-label={`选择或拖动 Provider ${providers[id].name || id} 排序`} draggable={!isDirty && busy === false} onDragStart={() => setDraggingProviderId(id)} onDragEnd={() => setDraggingProviderId(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => void moveProvider(id)} onClick={() => selectProvider(id)}><GripVertical className="configuration-sort-handle" size={15} aria-hidden="true" /><span><strong>{providers[id].name || id}</strong><small>{id}</small></span></button>)}</aside>
        <section className="provider-editor">
          <div className="configuration-form-card provider-form">
            <div className="configuration-section__heading"><div><span>01</span><h2>Provider</h2></div><small>{savedProvider ? selectedId : "未保存"}</small></div>
            {!savedProvider ? <label><span>Provider ID<small>创建后不可直接编辑；需要变更时使用“改名”迁移引用。</small></span><input aria-label="Provider ID" value={selectedId} onChange={(event) => setSelectedId(event.target.value)} placeholder="例如 my-provider" /></label> : null}
            <label><span>Provider 模板<small>选择后填入常用默认值</small></span><select aria-label="Provider 模板" value={template} onChange={(event) => { const next = event.target.value as ProviderTemplate; setTemplate(next); setDraft((current) => ({ ...current, ...templateDefaults[next] })); }}><option value="custom">自定义</option><option value="openai-compatible">OpenAI Compatible</option><option value="ollama">Ollama</option><option value="vllm">vLLM</option><option value="lm-studio">LM Studio</option></select></label>
            <label><span>显示名称</span><input value={draft.name ?? ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
            <label><span>Base URL</span><input value={draft.baseUrl ?? ""} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
            <label><span>API 协议</span><select value={draft.api ?? "openai-completions"} onChange={(event) => setDraft({ ...draft, api: event.target.value })}><option value="openai-completions">OpenAI Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
            <label><span>认证 Header</span><input type="checkbox" checked={draft.authHeader !== false} onChange={(event) => setDraft({ ...draft, authHeader: event.target.checked })} /></label>
            <KeyValueEditor label="Headers" rows={headers} onChange={setHeaders} />
            <label><span>API Key<small>留空不会修改现有凭证</small></span><input aria-label="API Key" type="password" autoComplete="new-password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={credential ? "输入新 Key 以替换" : "输入 API Key"} /></label>
            <div className="configuration-button-row"><button type="button" disabled={!savedProvider || !apiKey || busy !== false || !online} onClick={saveCredential}>保存凭证</button>{credential ? <button type="button" className="danger-link" disabled={!online || busy !== false} onClick={() => void removeCredential()}>删除凭证</button> : null}<small>{savedProvider ? (credential ? "已配置 · 不回显" : "未配置") : "请先创建 Provider"}</small></div>
          </div>

          <div className="configuration-form-card provider-form">
            <div className="configuration-section__heading"><div><span>02</span><h2>模型</h2></div><div className="provider-model-actions"><button type="button" disabled={!canDiscover} title={isDirty ? "请先保存 Provider 后发现模型" : undefined} onClick={() => void discoverModels()}>发现模型</button><button type="button" onClick={() => { setDraft({ ...draft, models: [...(draft.models ?? []), emptyModel()] }); setSelectedModelIndex(draft.models?.length ?? 0); }}><Plus size={14} aria-hidden="true" />添加模型</button></div></div>
            {isDirty && selectedId ? <p className="configuration-help">请先保存 Provider 后发现模型。</p> : null}
            {!draft.baseUrl?.trim() ? <p className="configuration-help">填写并保存 Base URL 后可发现模型。</p> : null}
            {draft.api && !discoveryApis.has(draft.api) ? <p className="configuration-help">当前协议不支持模型发现。</p> : null}
            {discoveredModels.length ? <fieldset className="provider-discovery-list" aria-label="发现的模型"><legend>发现的模型</legend>{discoveredModels.map((model) => <label className="provider-discovery-row" key={model.id}><input aria-label={`选择 ${model.id}`} type="checkbox" checked={selectedDiscoveredIds.has(model.id)} disabled={model.exists || busy !== false} onChange={(event) => toggleDiscoveredModel(model.id, event.target.checked)} /><span>{model.name}</span><small>{model.exists ? "已存在" : "待导入"}</small></label>)}<button type="button" disabled={busy !== false || ![...selectedDiscoveredIds].some((id) => discoveredModels.some((model) => model.id === id && !model.exists))} onClick={importDiscoveredModels}>导入所选模型</button></fieldset> : null}
            <div className="model-chip-list">{draft.models?.map((model, index) => <button type="button" key={`${model.id}-${index}`} className={selectedModelIndex === index ? "is-active model-chip-list__item" : "model-chip-list__item"} aria-label={`选择或拖动模型 ${model.name || model.id} 排序`} draggable={!isDirty && busy === false} onDragStart={() => setDraggingModelId(model.id)} onDragEnd={() => setDraggingModelId(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={() => void moveModel(model.id)} onClick={() => setSelectedModelIndex(index)}><GripVertical className="configuration-sort-handle" size={14} aria-hidden="true" />{model.name || model.id}</button>)}</div>
            {selectedModel ? <div className="model-editor-fields"><label><span>模型 ID</span><input value={selectedModel.id} onChange={(event) => updateModel({ id: event.target.value })} /></label><label><span>显示名称</span><input value={selectedModel.name ?? ""} onChange={(event) => updateModel({ name: event.target.value })} /></label><fieldset className="model-input-capabilities"><legend>输入能力</legend><div><label><input aria-label="文本输入" type="checkbox" checked disabled /><span>文本输入</span></label><label><input aria-label="图片输入" type="checkbox" checked={modelInput(selectedModel).includes("image")} onChange={(event) => setImageInput(event.target.checked)} /><span>图片输入</span></label></div><small>该设置声明模型可接受图片输入；实际视觉能力仍由 Provider 和远端模型决定。</small></fieldset><label><span>上下文窗口</span><input aria-label="上下文窗口" type="number" min="1" step="1" value={selectedModel.contextWindow ?? ""} onChange={(event) => updateModelCapacity("contextWindow", event.target.value)} /></label><label><span>最大返回 Token</span><input aria-label="最大返回 Token" type="number" min="1" step="1" value={selectedModel.maxTokens ?? ""} onChange={(event) => updateModelCapacity("maxTokens", event.target.value)} /></label><label><span>推理模型</span><input type="checkbox" checked={selectedModel.reasoning} onChange={(event) => updateModel({ reasoning: event.target.checked })} /></label><ThinkingLevelMapEditor value={selectedModel.thinkingLevelMap ?? {}} onChange={(thinkingLevelMap) => updateModel({ thinkingLevelMap })} /><details className="provider-advanced"><summary>兼容性</summary><p>自动会由核心根据 Provider 和 URL 推断；仅在模型服务不兼容时覆盖。</p><div className="model-editor-fields">{compatBooleanFields.map((field) => <label key={field.key}><span>{field.label}{field.help ? <small>{field.help}</small> : null}</span><select aria-label={field.label} value={compatBooleanValue(field.key)} onChange={(event) => updateCompatValue(field.key, event.target.value)}><option value="auto">自动</option><option value="on">开启</option><option value="off">关闭</option></select></label>)}<label><span>最大 Token 字段</span><select aria-label="最大 Token 字段" value={typeof selectedModel.compat?.maxTokensField === "string" ? selectedModel.compat.maxTokensField : "auto"} onChange={(event) => updateCompatOption("maxTokensField", event.target.value)}><option value="auto">自动</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label><label><span>思考格式</span><select aria-label="思考格式" value={typeof selectedModel.compat?.thinkingFormat === "string" ? selectedModel.compat.thinkingFormat : "auto"} onChange={(event) => updateCompatOption("thinkingFormat", event.target.value)}><option value="auto">自动</option><option value="openai">openai</option><option value="deepseek">deepseek</option><option value="zai">zai</option><option value="together">together</option><option value="ant-ling">ant-ling</option><option value="openrouter">openrouter</option></select></label></div></details><button type="button" className="danger-link" disabled={busy !== false} onClick={() => void deleteSelectedModel()}><Trash2 size={14} aria-hidden="true" />删除模型</button></div> : <p className="configuration-help">添加模型后可编辑推理能力和思考映射。</p>}
            <label className="provider-import"><span>批量导入模型 JSON<small>接受模型对象数组，导入后仍可逐项审阅</small></span><input type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; void file.text().then((text) => { const parsed = JSON.parse(text) as ProviderEditorModel[]; setDraft({ ...draft, models: [...(draft.models ?? []), ...parsed] }); setError(""); }).catch(() => setError("模型 JSON 文件无法读取或格式无效")); }} /></label>
          </div>

          <div className="configuration-form-card provider-form"><div className="configuration-section__heading"><div><span>03</span><h2>连接测试</h2></div></div><div className="configuration-button-row"><button type="button" disabled={!canTestCurrent} title={isDirty ? "请先保存 Provider 后测试" : undefined} onClick={() => selectedModel?.id && void testConnection({ scope: "current", modelId: selectedModel.id })}><TestTube2 size={14} aria-hidden="true" />测试当前模型</button><button type="button" disabled={!canTestAll} title={isDirty ? "请先保存 Provider 后测试" : undefined} onClick={() => void testConnection({ scope: "all" })}><TestTube2 size={14} aria-hidden="true" />测试全部模型</button></div>{isDirty && selectedId ? <p className="configuration-help">请先保存 Provider 后测试</p> : null}{testResults.length ? <ol className="connection-logs">{testResults.map((result) => <li key={result.modelId}>{result.modelName}：{result.ok ? `成功 · ${result.durationMs} ms${result.responsePreview ? ` · ${result.responsePreview}` : ""}` : `失败 · ${result.durationMs} ms · ${result.message ?? "模型请求失败"}`}</li>)}</ol> : null}</div>
          <details className="provider-advanced"><summary>高级 JSON</summary><p>仅编辑当前 Provider 节点；离开编辑框时解析，并仍由核心配置结构校验。</p><textarea key={`${selectedId}-${document.revision}`} aria-label="Provider 高级 JSON" rows={14} defaultValue={advancedJson} onBlur={(event) => { try { const parsed = JSON.parse(event.target.value) as ProviderNode; setDraft(parsed); setHeaders(rowsFromHeaders(parsed.headers)); setError(""); } catch { setError("高级 JSON 格式无效，尚未应用"); } }} /></details>
          <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" disabled={busy !== false || !selectedId || !online} onClick={saveProvider}><Save size={16} aria-hidden="true" />保存 Provider</button>{savedProvider ? <button type="button" className="configuration-secondary-action" aria-label="重命名 Provider" disabled={busy !== false || !online || isDirty} title={isDirty ? "请先保存当前修改后再改名" : undefined} onClick={() => setRenameOpen(true)}><PencilLine size={15} aria-hidden="true" />重命名</button> : null}<button type="button" className="configuration-icon-action" aria-label="删除 Provider" disabled={!ids.includes(selectedId) || !online || testing} onClick={async () => { if (!document) return; const updated = await api.removeProvider(selectedId, document.revision); setDocument({ ...document, ...updated }); setSelectedId(""); }}><Trash2 size={16} aria-hidden="true" /></button></div>
        </section>
      </div>
    </div>
  );
}
