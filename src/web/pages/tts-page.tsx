import { Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { TtsProfileInput, TtsProfileSummary } from "../../shared/tts-contracts";
import { api } from "../api";
import { SecretInput } from "../components/secret-input";
import { useOnlineStatus } from "../use-online-status";

const emptyDraft = (): TtsProfileInput => ({ name: "", baseUrl: "", model: "", voice: "", responseFormat: "mp3", apiKey: "" });
const CACHE_KEY = "pi-agent:tts-cache";

/** 配置多个 OpenAI 兼容的语音合成接口。 */
export function TtsPage() {
  const online = useOnlineStatus();
  const [profiles, setProfiles] = useState<TtsProfileSummary[]>([]);
  const [revision, setRevision] = useState("");
  const [selected, setSelected] = useState<TtsProfileSummary>();
  const [draft, setDraft] = useState<TtsProfileInput>(emptyDraft);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const cached = readCache();
    if (cached) { setProfiles(cached.profiles); setRevision(cached.revision); if (cached.profiles[0]) select(cached.profiles[0]); }
    void api.getTtsProfiles().then((document) => {
      setProfiles(document.profiles); setRevision(document.revision); if (document.profiles[0]) select(document.profiles[0]);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(document));
    }).catch(() => setMessage(cached ? "正在显示上次缓存的配置；离线时不能保存。" : "无法读取语音配置"));
  }, []);
  const select = (profile: TtsProfileSummary) => { setSelected(profile); setDraft({ name: profile.name, baseUrl: profile.baseUrl, model: profile.model, voice: profile.voice, responseFormat: profile.responseFormat, apiKey: "" }); setApiKeyVisible(false); };
  const update = <K extends keyof TtsProfileInput>(key: K, value: TtsProfileInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const toggleApiKeyVisibility = async () => {
    if (apiKeyVisible) { setApiKeyVisible(false); return; }
    try {
      if (selected?.hasApiKey && !draft.apiKey) {
        const value = await api.getTtsProfileCredential(selected.id);
        update("apiKey", value.apiKey);
      }
      setApiKeyVisible(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取 API Key"); }
  };
  const save = async () => {
    if (!online) return;
    setSaving(true); setMessage("");
    try {
      const result = selected ? await api.updateTtsProfile(selected.id, revision, draft) : await api.createTtsProfile(draft);
      const next = await api.getTtsProfiles();
      setProfiles(next.profiles); setRevision(next.revision); window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      const current = next.profiles.find((profile) => profile.id === selected?.id) ?? next.profiles.at(-1);
      if (current) select(current);
      setMessage("已保存语音配置");
      void result;
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!selected || !online) return;
    setSaving(true); setMessage("");
    try { await api.deleteTtsProfile(selected.id, revision); const next = await api.getTtsProfiles(); setProfiles(next.profiles); setRevision(next.revision); window.localStorage.setItem(CACHE_KEY, JSON.stringify(next)); setSelected(undefined); setDraft(emptyDraft()); setMessage("已删除语音配置"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "删除失败"); }
    finally { setSaving(false); }
  };
  return <main className="configuration-page"><header className="configuration-page__heading"><h1>语音合成</h1><p>管理 OpenAI Speech 兼容接口。密钥默认隐藏，点击小眼睛可按需查看。</p></header>
    {message ? <p className="configuration-help" role="status">{message}</p> : null}
    <section className="configuration-form-card"><div className="configuration-section__heading"><div><span>01</span><h2>语音模型</h2></div><button type="button" onClick={() => { setSelected(undefined); setDraft(emptyDraft()); }} disabled={!online}><Plus size={15} />新增</button></div>
      {profiles.length ? <div className="configuration-button-row">{profiles.map((profile) => <button type="button" key={profile.id} className={selected?.id === profile.id ? "secondary-button" : undefined} onClick={() => select(profile)}>{profile.name}</button>)}</div> : <p className="configuration-help">尚未配置语音模型。</p>}
      <label><span>配置名称</span><input aria-label="配置名称" value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
      <label><span>API Base URL</span><input aria-label="API Base URL" placeholder="https://example.com/v1" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
      <label><span>模型</span><input aria-label="TTS 模型" value={draft.model} onChange={(event) => update("model", event.target.value)} /></label>
      <label><span>音色</span><input aria-label="音色" value={draft.voice} onChange={(event) => update("voice", event.target.value)} /></label>
      <label><span>音频格式</span><select aria-label="音频格式" value={draft.responseFormat} onChange={(event) => update("responseFormat", event.target.value as TtsProfileInput["responseFormat"])}><option value="mp3">MP3</option><option value="opus">Opus</option><option value="wav">WAV</option><option value="pcm">PCM</option></select></label>
      <p className="configuration-help">OpenAI Speech 可流式传输多种格式；本应用当前仅对 PCM 启用边接收边播放。需要低延时时请选择 PCM，并确认上游接口支持 24 kHz、16 位小端单声道 PCM 的分块流式响应。</p>
      <label><span>API Key<small>{selected?.hasApiKey ? "留空则保留已配置密钥" : "仅保存到服务端"}</small></span><SecretInput aria-label="TTS API Key" autoComplete="new-password" value={draft.apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => update("apiKey", event.target.value)} /></label>
    </section>
    <div className="configuration-save-bar"><button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!selected || !online || saving} onClick={() => void remove()}><Trash2 size={15} />删除</button><button type="button" className="configuration-primary-action" disabled={!online || saving} onClick={() => void save()}><Save size={16} />{saving ? "保存中…" : "保存配置"}</button></div>
  </main>;
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
