import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TtsProfileInput, TtsProfileSummary } from "../../shared/tts-contracts";
import { api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { useUnsavedChanges } from "../components/configuration/unsaved-changes";
import "../configuration-interactions.css";
import { SecretInput } from "../components/secret-input";
import { formatTtsCustomParameters, parseTtsCustomParametersText } from "../tts-custom-parameters-form";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../tts.css";

const emptyDraft = (): TtsProfileInput => ({ name: "", baseUrl: "", model: "", voice: "", responseFormat: "mp3", customParameters: {}, apiKey: "" });
const CACHE_KEY = "pi-agent:tts-cache";

/** 配置多个 OpenAI 兼容的语音合成接口。 */
export function TtsPage() {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [profiles, setProfiles] = useState<TtsProfileSummary[]>([]);
  const [revision, setRevision] = useState("");
  const [selected, setSelected] = useState<TtsProfileSummary>();
  const [draft, setDraft] = useState<TtsProfileInput>(emptyDraft);
  const [customParametersText, setCustomParametersText] = useState("{}");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savedDraft, setSavedDraft] = useState<TtsProfileInput>(emptyDraft);
  const [savedParameters, setSavedParameters] = useState("{}");
  const [revealedKey, setRevealedKey] = useState("");
  const editingStarted = useRef(false);
  const dirty = (creating || Boolean(selected)) && (JSON.stringify({ ...draft, apiKey: "" }) !== JSON.stringify({ ...savedDraft, apiKey: "" })
    || customParametersText !== savedParameters || Boolean(draft.apiKey && draft.apiKey !== revealedKey));
  const guard = useUnsavedChanges({ dirty, busy: saving, label: selected ? `语音配置 · ${selected.name}` : "新增语音配置", save, canSave: online });
  useEffect(() => {
    const cached = readCache();
    if (cached) { setProfiles(cached.profiles); setRevision(cached.revision); }
    void (async () => {
      const result = cached
        ? await runOptionalApiTask(api.getTtsProfiles, {
            operation: "加载语音配置",
            fallbackReason: "正在显示上次缓存的配置；离线时不能保存。",
            fallback: () => cached,
          })
        : await runApiTask(api.getTtsProfiles, { operation: "加载语音配置" });
      if (result.status === "success" || result.status === "fallback") {
        const document = result.data;
        if (editingStarted.current) return;
        setProfiles(document.profiles); setRevision(document.revision); if (!editingStarted.current && document.profiles[0]) select(document.profiles[0]);
        if (result.status === "success") window.localStorage.setItem(CACHE_KEY, JSON.stringify(document));
        else setMessage(result.reason);
      }
    })();
  }, [runApiTask, runOptionalApiTask]);
  function select(profile: TtsProfileSummary) {
    editingStarted.current = true;
    const next = { name: profile.name, baseUrl: profile.baseUrl, model: profile.model, voice: profile.voice, responseFormat: profile.responseFormat, customParameters: profile.customParameters ?? {}, apiKey: "" };
    const parameters = formatTtsCustomParameters(profile.customParameters);
    setSelected(profile); setCreating(false); setDraft(next); setSavedDraft(next);
    setCustomParametersText(parameters); setSavedParameters(parameters); setApiKeyVisible(false); setRevealedKey("");
  }

  /** 显式进入新建模式，空列表不隐式提交新配置。 */
  function create() {
    editingStarted.current = true;
    const next = emptyDraft();
    setSelected(undefined); setCreating(true); setDraft(next); setSavedDraft(next);
    setCustomParametersText("{}"); setSavedParameters("{}"); setApiKeyVisible(false); setRevealedKey(""); setMessage("");
  }

  function cancelCreate() {
    setCreating(false); setDraft(emptyDraft()); setCustomParametersText("{}"); setApiKeyVisible(false); setRevealedKey("");
  }
  const update = <K extends keyof TtsProfileInput>(key: K, value: TtsProfileInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const toggleApiKeyVisibility = async () => {
    if (saving) return;
    if (apiKeyVisible) { setApiKeyVisible(false); return; }
    if (!selected?.hasApiKey || draft.apiKey) { setApiKeyVisible(true); return; }
    setSaving(true);
    try {
      const result = await runApiTask(() => api.getTtsProfileCredential(selected.id), { operation: "读取语音 API Key", expected: ttsExpected(setMessage) });
      if (result.status === "success") { update("apiKey", result.data.apiKey); setRevealedKey(result.data.apiKey); setApiKeyVisible(true); }
    } finally { setSaving(false); }
  };
  async function save(): Promise<boolean> {
    if (!online || saving || (!selected && !creating)) return false;
    let customParameters;
    try {
      customParameters = parseTtsCustomParametersText(customParametersText);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TTS 自定义请求参数无效");
      return false;
    }
    const input = { ...draft, customParameters };
    setSaving(true); setMessage("");
    try {
      const result = await runApiTask(
        () => selected ? api.updateTtsProfile(selected.id, revision, input) : api.createTtsProfile(input),
        { operation: "保存语音配置", expected: ttsExpected(setMessage) },
      );
      if (result.status !== "success") return false;
      // 保存响应带确切对象与 revision，避免重读失败后误判可重新创建。
      const current = result.data.profile;
      const nextProfiles = selected ? profiles.map((item) => item.id === current.id ? current : item) : [...profiles, current];
      setProfiles(nextProfiles); setRevision(result.data.revision);
      select(current);
      await runApiTask(async () => window.localStorage.setItem(CACHE_KEY, JSON.stringify({ profiles: nextProfiles, revision: result.data.revision })), { operation: "更新已保存语音配置的离线摘要" });
      setMessage(selected ? "语音配置修改已保存" : "语音配置已创建");
      return true;
    } catch (error) {
      await runApiTask(async () => { throw error; }, { operation: "刷新语音配置" });
      return false;
    }
    finally { setSaving(false); }
  }
  const remove = async () => {
    if (!selected || !online) return;
    setSaving(true); setMessage("");
    try {
      const result = await runApiTask(
        () => api.deleteTtsProfile(selected.id, revision),
        { operation: "删除语音配置", expected: ttsExpected(setMessage) },
      );
      if (result.status !== "success") return;
      const next = await api.getTtsProfiles(); setProfiles(next.profiles); setRevision(next.revision); window.localStorage.setItem(CACHE_KEY, JSON.stringify(next)); setSelected(undefined); setCreating(false); setDraft(emptyDraft()); setCustomParametersText("{}"); setMessage("已删除语音配置");
    } catch (error) {
      await runApiTask(async () => { throw error; }, { operation: "刷新语音配置" });
    }
    finally { setSaving(false); }
  };
  return <main className="configuration-page configuration-quick-wins-page"><header className="configuration-page__heading"><h1>语音合成</h1><p>管理 OpenAI Speech 兼容接口。密钥默认隐藏，点击小眼睛可按需查看。</p></header>
    {guard.dialog}
    {message ? <p className="configuration-help" role="status">{message}</p> : null}
    <section className="configuration-form-card"><div className="configuration-section__heading"><div><span>01</span><h2>语音配置</h2></div><button type="button" onClick={() => guard.request(create)} disabled={!online}><Plus size={15} />新增语音配置</button></div>
      {profiles.length ? <div className="configuration-button-row">{profiles.map((profile) => <button type="button" key={profile.id} className={selected?.id === profile.id ? "secondary-button" : undefined} onClick={() => { if (profile.id !== selected?.id) guard.request(() => select(profile)); }}>{profile.name}</button>)}</div> : <p className="configuration-help">尚未配置语音模型。</p>}
    </section>
    {selected || creating ? <>
    <section className="configuration-form-card">
      <div className="configuration-section__heading"><div><h2>{selected ? `编辑语音配置 · ${selected.name}` : "新增语音配置"}</h2></div><small>{dirty ? "未保存" : creating ? "新建草稿" : "已保存"}</small></div>
      <fieldset className="configuration-interaction-fields" disabled={saving}><div className="tts-editor-fields">
      <label><span>配置名称</span><input aria-label="配置名称" value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
      <label><span>API Base URL</span><input aria-label="API Base URL" placeholder="https://example.com/v1" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
      <label><span>模型</span><input aria-label="TTS 模型" value={draft.model} onChange={(event) => update("model", event.target.value)} /></label>
      <label><span>音色</span><input aria-label="音色" value={draft.voice} onChange={(event) => update("voice", event.target.value)} /></label>
      <label><span>音频格式</span><select aria-label="音频格式" value={draft.responseFormat} onChange={(event) => update("responseFormat", event.target.value as TtsProfileInput["responseFormat"])}><option value="mp3">MP3</option><option value="opus">Opus</option><option value="wav">WAV</option><option value="pcm">PCM</option></select></label>
      <label><span>API Key<small>{selected?.hasApiKey ? "留空则保留已配置密钥" : "仅保存到服务端"}</small></span><SecretInput aria-label="TTS API Key" autoComplete="new-password" value={draft.apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => update("apiKey", event.target.value)} /></label>
      <p className="configuration-help">OpenAI Speech 可流式传输多种格式；本应用当前仅对 PCM 启用边接收边播放。需要低延时时请选择 PCM，并确认上游接口支持 24 kHz、16 位小端单声道 PCM 的分块流式响应。</p>
      <details><summary>高级请求参数</summary><label><span>自定义请求参数（JSON）<small>模型级参数会覆盖上方默认字段</small></span><textarea aria-label="TTS 自定义请求参数" rows={7} spellCheck={false} value={customParametersText} onChange={(event) => setCustomParametersText(event.target.value)} /></label>
      <p className="configuration-help">仅填写请求体参数，例如 <code>instructions</code> 或 <code>response_format</code>。不能覆盖 <code>input</code>，也不要填写 API Key、账号或身份信息。</p></details>
      </div></fieldset>
    </section>
    <div className="configuration-save-bar"><span className="configuration-editing-state">{dirty ? "有未保存的修改" : "当前没有未保存的修改"}</span>{creating ? <button type="button" className="configuration-secondary-action" disabled={saving} onClick={() => guard.request(cancelCreate)}>取消新增</button> : null}<button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!selected || !online || saving} onClick={() => void remove()}><Trash2 size={15} />删除</button><button type="button" className="configuration-primary-action" disabled={!online || saving} onClick={() => void save()}><Save size={16} />{saving ? "保存中…" : selected ? "保存更改" : "创建语音配置"}</button></div>
    </> : <section className="configuration-form-card"><h2>选择语音配置进行编辑</h2><p className="configuration-help">也可以点击“新增语音配置”创建新的配置。</p></section>}
  </main>;
}

/** 将语音配置的可恢复业务错误保留在当前表单中。 */
function ttsExpected(setMessage: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setMessage(error.message);
  return {
    VERSION_CONFLICT: show,
    VALIDATION_FAILED: show,
    CREDENTIAL_NOT_FOUND: show,
    MODEL_IN_USE: show,
  };
}

/** 只缓存脱敏后的配置摘要，确保离线页不会落地密钥。 */
function readCache(): { revision: string; profiles: TtsProfileSummary[] } | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "");
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as { revision?: unknown; profiles?: unknown };
    if (typeof value.revision !== "string" || !Array.isArray(value.profiles)) return undefined;
    return { revision: value.revision, profiles: value.profiles as TtsProfileSummary[] };
  } catch { return undefined; }
}
