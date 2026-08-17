import { Plus, Save, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AigcChannelInput,
  AigcChannelSummary,
  AigcChannelTemplate,
  AigcChannelType,
  AigcSettingsDocument,
} from "../../shared/aigc-contracts";
import { api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { SecretInput } from "../components/secret-input";
import { useOnlineStatus } from "../use-online-status";

const CACHE_KEY = "pi-agent:aigc-channels-cache";

/** 配置中心里的 AIGC 渠道维护页。 */
export function AigcChannelsPage() {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<AigcSettingsDocument>();
  const [selected, setSelected] = useState<AigcChannelSummary>();
  const [draft, setDraft] = useState<AigcChannelInput>(emptyDraft);
  const [draftId, setDraftId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<false | "saving" | "testing">(false);

  useEffect(() => {
    const cached = readCache();
    if (cached) {
      setDocument(cached);
      if (cached.channels[0]) select(cached, cached.channels[0]);
    }
    void (async () => {
      const result = cached
        ? await runOptionalApiTask(api.getAigcChannels, {
            operation: "加载 AIGC 渠道",
            fallbackReason: "正在显示上次缓存的配置；离线时不能保存。",
            fallback: () => cached,
          })
        : await runApiTask(api.getAigcChannels, { operation: "加载 AIGC 渠道" });
      if (result.status === "success" || result.status === "fallback") {
        const next = result.data;
        setDocument(next);
        if (next.channels[0]) select(next, next.channels[0]);
        if (result.status === "success") window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
        else setMessage(result.reason);
      }
    })();
  }, [runApiTask, runOptionalApiTask]);

  const channels = document?.channels ?? [];
  const templates = document?.channelTemplates ?? [];
  const selectedTemplate = templates.find((template) => template.type === draft.type);

  function select(documentValue: AigcSettingsDocument, channel: AigcChannelSummary) {
    setDocument(documentValue);
    setSelected(channel);
    setDraft({ name: channel.name, type: channel.type, baseUrl: channel.baseUrl, enabled: channel.enabled, timeoutMs: channel.timeoutMs });
    setDraftId(channel.id);
    setApiKey("");
    setApiKeyVisible(false);
  }

  function createDraft(template?: AigcChannelTemplate) {
    setSelected(undefined);
    setDraftId(crypto.randomUUID());
    setDraft({
      name: "",
      type: template?.type ?? "openai",
      baseUrl: template?.defaultBaseUrl ?? "",
      enabled: true,
      timeoutMs: 30_000,
    });
    setApiKey("");
    setApiKeyVisible(false);
  }

  function updateDraft<K extends keyof AigcChannelInput>(key: K, value: AigcChannelInput[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function toggleApiKeyVisibility() {
    if (apiKeyVisible) {
      setApiKeyVisible(false);
      return;
    }
    if (!selected?.hasApiKey || apiKey) {
      setApiKeyVisible(true);
      return;
    }
    const result = await runApiTask(() => api.getAigcChannelCredential(selected.id), {
      operation: "读取 AIGC 渠道 API Key",
      expected: aigcExpected(setMessage),
    });
    if (result.status === "success") {
      setApiKey(result.data.apiKey);
      setApiKeyVisible(true);
    }
  }

  async function save() {
    if (!online || !document) return;
    setBusy("saving");
    setMessage("");
    try {
      const input = { ...draft, baseUrl: draft.baseUrl.trim() };
      const result = selected
        ? await runApiTask(() => api.updateAigcChannel(selected.id, {
            configRevision: document.revision,
            credentialRevision: document.credentialRevision,
            channel: { ...input, id: selected.id },
            credential: apiKey ? { action: "replace", apiKey } : selected.hasApiKey ? { action: "keep" } : { action: "remove" },
          }), { operation: "保存 AIGC 渠道", expected: aigcExpected(setMessage) })
        : await runApiTask(() => api.createAigcChannel({
            configRevision: document.revision,
            credentialRevision: document.credentialRevision,
            channel: { ...input, id: draftId },
            ...(apiKey ? { apiKey } : {}),
          }), { operation: "保存 AIGC 渠道", expected: aigcExpected(setMessage) });
      if (result.status !== "success") return;
      const next = await api.getAigcChannels();
      setDocument(next);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      const current = next.channels.find((channel) => channel.id === selected?.id) ?? next.channels.at(-1);
      if (current) select(next, current);
      setMessage("已保存 AIGC 渠道");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected || !online || !document) return;
    setBusy("saving");
    setMessage("");
    try {
      const result = await runApiTask(() => api.deleteAigcChannel(selected.id, document.revision, document.credentialRevision), {
        operation: "删除 AIGC 渠道",
        expected: aigcExpected(setMessage),
      });
      if (result.status !== "success") return;
      const next = await api.getAigcChannels();
      setDocument(next);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(next));
      setSelected(undefined);
      setDraft(emptyDraft);
      setDraftId("");
      setMessage("已删除 AIGC 渠道");
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (!selected || !online) return;
    setBusy("testing");
    setMessage("");
    try {
      const result = await runApiTask(() => api.testAigcChannel(selected.id), {
        operation: "测试 AIGC 渠道",
        expected: aigcExpected(setMessage),
      });
      if (result.status === "success") setMessage(result.data.ok ? "连接正常" : result.data.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="configuration-page">
      <header className="configuration-page__heading">
        <h1>AIGC 渠道</h1>
        <p>维护 OpenAI、Grok 与 ComfyUI 的连接地址和凭证。ComfyUI 可匿名访问内网服务。</p>
      </header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="configuration-section__heading">
          <div><span>01</span><h2>渠道</h2></div>
          <button type="button" onClick={() => createDraft()} disabled={!online}><Plus size={15} />新增</button>
        </div>
        <div className="configuration-button-row">
          {templates.map((template) => (
            <button type="button" key={template.id} className="secondary-button" onClick={() => createDraft(template)}>
              添加 {template.name}
            </button>
          ))}
        </div>
        {channels.length ? (
          <div className="configuration-button-row">
            {channels.map((channel) => (
              <button type="button" key={channel.id} className={selected?.id === channel.id ? "is-selected" : undefined} onClick={() => document && select(document, channel)}>
                {channel.name}
              </button>
            ))}
          </div>
        ) : <p className="configuration-help">尚未配置 AIGC 渠道。</p>}
        <label><span>协议</span>
          <select aria-label="AIGC 渠道协议" value={draft.type} onChange={(event) => {
            const type = event.target.value as AigcChannelType;
            const template = templates.find((item) => item.type === type);
            updateDraft("type", type);
            if (template && !draft.baseUrl) updateDraft("baseUrl", template.defaultBaseUrl);
          }}>
            <option value="openai">OpenAI</option>
            <option value="grok">Grok</option>
            <option value="comfyui">ComfyUI</option>
          </select>
        </label>
        <label><span>渠道名称</span><input aria-label="AIGC 渠道名称" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
        <label><span>Base URL</span><input aria-label="AIGC Base URL" placeholder={selectedTemplate?.defaultBaseUrl} value={draft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} /></label>
        <label><span>请求超时（毫秒）</span><input type="number" min={1000} max={300000} step={1000} aria-label="AIGC 请求超时" value={draft.timeoutMs} onChange={(event) => updateDraft("timeoutMs", Number(event.target.value))} /></label>
        <label className="configuration-check-line"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft("enabled", event.target.checked)} /><span>允许接口引用该渠道</span></label>
        {selectedTemplate?.credentialOptional ? (
          <p className="configuration-help">ComfyUI 通常在内网匿名运行；如上游启用了认证，可在这里填写 API Key。</p>
        ) : <p className="configuration-help">OpenAI 与 Grok 渠道必须配置 API Key，密钥仅保存在服务端。</p>}
        <label><span>API Key<small>{selected?.hasApiKey ? "留空则保留已配置密钥" : "仅保存到服务端"}</small></span><SecretInput aria-label="AIGC API Key" autoComplete="new-password" value={apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => setApiKey(event.target.value)} /></label>
      </section>
      <div className="configuration-save-bar">
        <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!selected || !online || busy !== false} onClick={() => void remove()}><Trash2 size={15} />删除</button>
        <button type="button" className="configuration-secondary-action" disabled={!selected || !online || busy !== false} onClick={() => void test()}><TestTube2 size={15} />{busy === "testing" ? "测试中…" : "测试连接"}</button>
        <button type="button" className="configuration-primary-action" disabled={!online || busy !== false} onClick={() => void save()}><Save size={16} />{busy === "saving" ? "保存中…" : "保存配置"}</button>
      </div>
    </main>
  );
}

const emptyDraft: AigcChannelInput = { name: "", type: "openai", baseUrl: "", enabled: true, timeoutMs: 30_000 };

/** 将可恢复业务错误保留在当前表单中。 */
function aigcExpected(setMessage: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setMessage(error.message);
  return {
    VERSION_CONFLICT: show,
    VALIDATION_FAILED: show,
    CREDENTIAL_NOT_FOUND: show,
    NOT_FOUND: show,
  };
}

/** 只缓存脱敏配置，确保离线页不会落地密钥。 */
function readCache(): AigcSettingsDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "");
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as { channels?: unknown; channelTemplates?: unknown; credentials?: unknown };
    if (!Array.isArray(value.channels) || !Array.isArray(value.channelTemplates) || !Array.isArray(value.credentials)) return undefined;
    return parsed as AigcSettingsDocument;
  } catch {
    return undefined;
  }
}
