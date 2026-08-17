import { Check, Save, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import type { ScopedConfigDocument, WebPiSettings } from "../../shared/configuration-contracts";
import { api, type ModelSummary } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { ConflictDialog, type ConfigurationDifference } from "../components/configuration/conflict-dialog";
import { InheritedField } from "../components/configuration/inherited-field";
import { SettingsSection } from "../components/configuration/settings-section";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../pi-settings.css";

type FieldKind = "text" | "number" | "boolean" | "select" | "csv";
interface SettingField {
  path: string;
  label: string;
  kind: FieldKind;
  options?: string[];
  unit?: string;
  risk?: string;
  globalOnly?: boolean;
}
interface SettingGroup { title: string; description: string; fields: SettingField[] }

const groups: SettingGroup[] = [
  { title: "模型与推理", description: "默认模型和思考策略", fields: [
    { path: "defaultThinkingLevel", label: "默认思考等级", kind: "select", options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
    { path: "hideThinkingBlock", label: "隐藏思考块", kind: "boolean" },
  ] },
  { title: "压缩", description: "上下文压缩与分支摘要", fields: [
    { path: "compaction.enabled", label: "启用压缩", kind: "boolean" }, { path: "compaction.reserveTokens", label: "压缩保留 Token", kind: "number", unit: "tokens" },
    { path: "compaction.keepRecentTokens", label: "保留最近 Token", kind: "number", unit: "tokens" }, { path: "branchSummary.reserveTokens", label: "分支摘要保留 Token", kind: "number", unit: "tokens" },
  ] },
  { title: "重试", description: "失败恢复和 Provider 超时", fields: [
    { path: "retry.enabled", label: "启用重试", kind: "boolean" }, { path: "retry.maxRetries", label: "最大重试次数", kind: "number", unit: "次" },
    { path: "retry.baseDelayMs", label: "基础退避", kind: "number", unit: "ms" }, { path: "retry.provider.timeoutMs", label: "Provider 超时", kind: "number", unit: "ms" },
    { path: "retry.provider.maxRetries", label: "Provider 最大重试", kind: "number", unit: "次" }, { path: "retry.provider.maxRetryDelayMs", label: "Provider 最大退避", kind: "number", unit: "ms" },
  ] },
  { title: "消息传输", description: "流式通道和队列行为", fields: [
    { path: "transport", label: "传输方式", kind: "select", options: ["auto", "sse", "websocket", "websocket-cached"] },
    { path: "steeringMode", label: "引导消息模式", kind: "select", options: ["all", "one-at-a-time"] }, { path: "followUpMode", label: "后续消息模式", kind: "select", options: ["all", "one-at-a-time"] },
    { path: "httpIdleTimeoutMs", label: "HTTP 空闲超时", kind: "number", unit: "ms" }, { path: "websocketConnectTimeoutMs", label: "WebSocket 连接超时", kind: "number", unit: "ms" },
  ] },
  { title: "图片", description: "输入图片处理", fields: [
    { path: "images.autoResize", label: "自动缩放图片", kind: "boolean" }, { path: "images.blockImages", label: "阻止图片输入", kind: "boolean" },
  ] },
  { title: "Shell 与网络", description: "高风险运行环境选项", fields: [
    { path: "shellPath", label: "Shell 路径", kind: "text", risk: "改变 Agent 执行命令所用的 Shell。" },
    { path: "shellCommandPrefix", label: "Shell 命令前缀", kind: "text", risk: "会添加到每条 Shell 命令前，请确认内容可信。" },
    { path: "npmCommand", label: "npm 命令", kind: "csv", risk: "以逗号分隔命令及参数。" },
    { path: "httpProxy", label: "HTTP 代理", kind: "text", globalOnly: true, risk: "仅全局可改，会影响模型网络请求。" },
  ] },
  { title: "资源路径", description: "Packages、Skills 与扩展来源", fields: [
    { path: "packages", label: "Packages", kind: "csv" }, { path: "extensions", label: "Extensions", kind: "csv" }, { path: "skills", label: "Skills", kind: "csv" }, { path: "prompts", label: "Prompts", kind: "csv" },
  ] },
];

type SettingsRecord = Record<string, unknown>;

/**
 * 默认模型配置必须同时包含 Provider 与模型标识，避免形成无效组合。
 */
interface DefaultModelChoice {
  provider: string;
  model: string;
}

function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as SettingsRecord)[segment];
  }
  return current;
}

function setPath(source: SettingsRecord, path: string, value: unknown): SettingsRecord {
  const next = structuredClone(source);
  const parts = path.split(".");
  let current = next;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== "object" || current[part] === null || Array.isArray(current[part])) current[part] = {};
    current = current[part] as SettingsRecord;
  }
  current[parts.at(-1)!] = value;
  return next;
}

function deletePath(source: SettingsRecord, path: string): SettingsRecord {
  const next = structuredClone(source);
  const parts = path.split(".");
  const stack: Array<[SettingsRecord, string]> = [];
  let current = next;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== "object" || current[part] === null) return next;
    stack.push([current, part]); current = current[part] as SettingsRecord;
  }
  delete current[parts.at(-1)!];
  for (const [parent, key] of stack.reverse()) if (Object.keys(parent[key] as SettingsRecord).length === 0) delete parent[key];
  return next;
}

function displayValue(value: unknown, kind: FieldKind): string | number {
  if (kind === "csv") return Array.isArray(value) ? value.map(String).join(", ") : "";
  if (kind === "number") return typeof value === "number" ? value : "";
  return typeof value === "string" ? value : "";
}

function inheritedLabel(value: unknown): string {
  if (value === undefined) return "核心默认值";
  if (Array.isArray(value)) return value.join(", ") || "空列表";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * 从配置对象中读取完整的默认模型组合。
 */
function readDefaultModelChoice(source: unknown): DefaultModelChoice | undefined {
  const provider = getPath(source, "defaultProvider");
  const model = getPath(source, "defaultModel");
  return typeof provider === "string" && typeof model === "string" && provider && model ? { provider, model } : undefined;
}

/**
 * 生成不会受 Provider 或模型标识中分隔符影响的下拉选项值。
 */
function defaultModelChoiceKey(choice: DefaultModelChoice): string {
  return JSON.stringify([choice.provider, choice.model]);
}

/**
 * 解析页面下拉框提交的默认模型组合。
 */
function parseDefaultModelChoice(value: string): DefaultModelChoice | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") return { provider: parsed[0], model: parsed[1] };
  } catch {
    // 下拉框值来自受控选项，解析失败时按未选择处理，避免写入错误配置。
  }
  return undefined;
}

/**
 * 将已保存但尚未被发现的模型保留在选项中，防止保存其他设置时丢失历史配置。
 */
function defaultModelOptions(models: ModelSummary[], current: DefaultModelChoice | undefined): ModelSummary[] {
  if (!current || models.some((model) => model.provider === current.provider && model.id === current.model)) return models;
  return [{ provider: current.provider, id: current.model, name: `${current.model}（当前配置，未发现）` }, ...models];
}

/** 将运行设置的可恢复校验错误保留在当前表单。 */
function settingsExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_SETTINGS_REQUEST: show,
    SETTINGS_INVALID: show,
    GLOBAL_ONLY_SETTING: show,
    INVALID_SETTING_TYPE: show,
    SETTING_OUT_OF_RANGE: show,
    UNKNOWN_SETTING: show,
  };
}

/** 复用七组设置表单编辑全局值与 Agent 覆盖，并展示最终有效配置。 */
export function PiSettingsPage() {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [scope, setScope] = useState<"global" | "agent">("global");
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [agentId, setAgentId] = useState("");
  const [document, setDocument] = useState<ScopedConfigDocument<WebPiSettings>>();
  const [draft, setDraft] = useState<SettingsRecord>({});
  const [inherit, setInherit] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<{ latest: ScopedConfigDocument<WebPiSettings>; differences: ConfigurationDifference[] }>();

  useEffect(() => { void runOptionalApiTask(api.listAgents, { operation: "加载 Agent 目录", fallbackReason: "Agent 目录不可用", fallback: () => ({ agents: [] }) }).then((result) => { if (result.status === "success" || result.status === "fallback") { setAgents(result.data.agents); setAgentId((current) => current || result.data.agents[0]?.profile.id || ""); } }); }, [runOptionalApiTask]);
  useEffect(() => { void runOptionalApiTask(api.listModels, { operation: "加载模型目录", fallbackReason: "模型目录不可用", fallback: () => ({ models: [] }) }).then((result) => { if (result.status === "success" || result.status === "fallback") setModels(result.data.models); }); }, [runOptionalApiTask]);
  useEffect(() => {
    let active = true;
    setDocument(undefined); setError(""); setNotice(""); setInherit([]);
    const request = scope === "global" ? api.getGlobalSettings() : agentId ? api.getAgentSettings(agentId) : undefined;
    if (request) void runApiTask(() => request, { operation: "加载运行设置" }).then((result) => {
      if (active && result.status === "success") { setDocument(result.data); setDraft(structuredClone(result.data.own) as SettingsRecord); }
    });
    return () => { active = false; };
  }, [scope, agentId, runApiTask]);

  function update(path: string, value: unknown) {
    setDraft((current) => setPath(current, path, value));
    setInherit((current) => current.filter((item) => item !== path)); setNotice("");
  }

  function toggleInherited(path: string, inherited: boolean) {
    if (inherited) { setDraft((current) => deletePath(current, path)); setInherit((current) => [...new Set([...current, path])]); }
    else { update(path, getPath(document?.effective, path)); }
  }

  /**
   * 在草稿中原子更新默认 Provider 与模型，确保二者始终指向同一项选择。
   */
  function updateDefaultModel(choice: DefaultModelChoice | undefined) {
    setDraft((current) => {
      let next = deletePath(deletePath(current, "defaultProvider"), "defaultModel");
      if (choice) {
        next = setPath(next, "defaultProvider", choice.provider);
        next = setPath(next, "defaultModel", choice.model);
      }
      return next;
    });
    setInherit((current) => current.filter((item) => item !== "defaultProvider" && item !== "defaultModel"));
    setNotice("");
  }

  /**
   * Agent 作用域将默认 Provider 与模型作为同一个继承单元处理。
   */
  function toggleDefaultModelInherited(inherited: boolean) {
    if (!inherited) {
      const effectiveChoice = readDefaultModelChoice(document?.effective);
      if (effectiveChoice) updateDefaultModel(effectiveChoice);
      return;
    }
    setDraft((current) => deletePath(deletePath(current, "defaultProvider"), "defaultModel"));
    setInherit((current) => [...new Set([...current, "defaultProvider", "defaultModel"])]);
    setNotice("");
  }

  function control(field: SettingField, value: unknown, disabled = false) {
    if (field.kind === "boolean") return <input aria-label={field.label} type="checkbox" disabled={disabled} checked={value === true} onChange={(event) => update(field.path, event.target.checked)} />;
    if (field.kind === "select") return <select aria-label={field.label} disabled={disabled} value={displayValue(value, field.kind)} onChange={(event) => update(field.path, event.target.value)}><option value="">核心默认值</option>{field.options?.map((option) => <option key={option} value={option}>{option}</option>)}</select>;
    return <input aria-label={field.label} disabled={disabled} type={field.kind === "number" ? "number" : "text"} value={displayValue(value, field.kind)} onChange={(event) => update(field.path, field.kind === "number" ? Number(event.target.value) : field.kind === "csv" ? event.target.value.split(",").map((item) => item.trim()).filter(Boolean) : event.target.value)} />;
  }

  async function save() {
    if (!document) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const result = await runApiTask(
        () => scope === "global" ? api.updateGlobalSettings(document.revision, draft, []) : api.updateAgentSettings(agentId, document.revision, draft, inherit),
        {
          operation: "保存运行设置",
          expected: {
            ...settingsExpected(setError),
            VERSION_CONFLICT: async () => {
          const latest = scope === "global" ? await api.getGlobalSettings() : await api.getAgentSettings(agentId);
          setConflict({ latest, differences: collectDifferences(draft, latest.own as SettingsRecord) });
          setError("");
            },
          },
        },
      );
      if (result.status === "success") { setDocument(result.data); setDraft(structuredClone(result.data.own) as SettingsRecord); setInherit([]); setNotice("设置已保存"); }
    }
    finally { setSaving(false); }
  }

  async function reapplyConflict() {
    if (!conflict) return;
    setSaving(true);
    try {
      const result = await runApiTask(
        () => scope === "global" ? api.updateGlobalSettings(conflict.latest.revision, draft, []) : api.updateAgentSettings(agentId, conflict.latest.revision, draft, inherit),
        { operation: "重新应用运行设置", expected: settingsExpected(setError) },
      );
      if (result.status === "success") { setDocument(result.data); setDraft(structuredClone(result.data.own) as SettingsRecord); setInherit([]); setConflict(undefined); setNotice("设置已在最新版本上重新应用"); }
      else if (result.status !== "handled") setConflict(undefined);
    }
    finally { setSaving(false); }
  }

  return (
    <div className="configuration-page pi-settings-page">
      {conflict ? <ConflictDialog differences={conflict.differences} onReload={() => { setDocument(conflict.latest); setDraft(structuredClone(conflict.latest.own) as SettingsRecord); setInherit([]); setConflict(undefined); }} onReapply={() => void reapplyConflict()} /> : null}
      <header className="configuration-page__heading"><span className="configuration-eyebrow">RUNTIME SETTINGS</span><h1>运行设置</h1><p>统一管理默认模型与运行策略；Agent 覆盖会在全局规则上生效。</p><p className="configuration-help">保存到配置文件后，请到系统诊断刷新核心配置。</p></header>
      <div className="settings-scope-bar"><label>设置作用域<select aria-label="设置作用域" value={scope} onChange={(event) => setScope(event.target.value as "global" | "agent")}><option value="global">全局</option><option value="agent">Agent 覆盖</option></select></label>{scope === "agent" ? <label>Agent<select aria-label="选择 Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>{agents.map(({ profile }) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label> : null}</div>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}{notice ? <p className="configuration-save-notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p> : null}
      {!document ? <div className="configuration-state"><p>{error || "正在加载设置…"}</p></div> : <>
        <div className="settings-groups">{groups.map((group, index) => <SettingsSection key={group.title} index={index + 1} title={group.title} description={group.description}>{index === 0 ? (() => {
          const ownChoice = readDefaultModelChoice(draft);
          const effectiveChoice = readDefaultModelChoice(document.effective);
          const currentChoice = scope === "agent" ? ownChoice ?? effectiveChoice : ownChoice;
          const options = defaultModelOptions(models, currentChoice);
          const selector = <select aria-label="默认模型" disabled={scope === "agent" && !ownChoice} value={currentChoice ? defaultModelChoiceKey(currentChoice) : ""} onChange={(event) => updateDefaultModel(parseDefaultModelChoice(event.target.value))}><option value="">核心默认值</option>{options.map((model) => <option key={defaultModelChoiceKey({ provider: model.provider, model: model.id })} value={defaultModelChoiceKey({ provider: model.provider, model: model.id })}>{model.provider} / {model.name || model.id}</option>)}</select>;
          if (scope === "agent") return <InheritedField label="默认模型" inherited={!ownChoice} inheritedValue={effectiveChoice ? `${effectiveChoice.provider} / ${effectiveChoice.model}` : "核心默认值"} onInheritedChange={toggleDefaultModelInherited} help="同时覆盖 Provider 与模型。">{selector}</InheritedField>;
          return <label><span>默认模型<small>选择已配置的 Provider 与模型</small></span>{selector}</label>;
        })() : null}{group.fields.map((field) => {
          const ownValue = getPath(draft, field.path); const effectiveValue = getPath(document.effective, field.path); const inheritedValue = getPath(document.inherited, field.path);
          if (scope === "agent" && !field.globalOnly) return <InheritedField key={field.path} label={field.label} inherited={ownValue === undefined} inheritedValue={inheritedLabel(inheritedValue ?? effectiveValue)} onInheritedChange={(value) => toggleInherited(field.path, value)} help={field.risk || (field.unit ? `单位：${field.unit}` : undefined)}>{control(field, ownValue ?? effectiveValue)}</InheritedField>;
          return <label key={field.path}><span>{field.label}<small>{field.risk ? <><ShieldAlert size={12} aria-hidden="true" />{field.risk}</> : field.globalOnly && scope === "agent" ? "仅全局可修改" : field.unit ? `单位：${field.unit}` : "使用核心默认值"}</small></span>{control(field, scope === "agent" ? effectiveValue : ownValue, scope === "agent" && field.globalOnly)}</label>;
        })}</SettingsSection>)}</div>
        <section className="effective-settings"><header><h2>最终有效值</h2><small>{scope === "global" ? "全局" : "全局 + Agent 覆盖"}</small></header><pre>{JSON.stringify(document.effective, null, 2)}</pre></section>
        <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" onClick={save} disabled={saving || !online} title={!online ? "离线时不能保存配置" : undefined}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存设置"}</button></div>
      </>}
    </div>
  );
}

function collectDifferences(local: SettingsRecord, disk: SettingsRecord): ConfigurationDifference[] {
  const fields = new Set([...flattenPaths(local), ...flattenPaths(disk)]);
  return [...fields].filter((field) => JSON.stringify(getPath(local, field)) !== JSON.stringify(getPath(disk, field))).map((field) => ({ field, local: getPath(local, field), disk: getPath(disk, field) }));
}

function flattenPaths(value: SettingsRecord, prefix = ""): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof child === "object" && child !== null && !Array.isArray(child) ? flattenPaths(child as SettingsRecord, path) : [path];
  });
}
