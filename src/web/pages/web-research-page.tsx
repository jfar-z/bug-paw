import { ArrowDown, ArrowUp, ChevronDown, ChevronUp, KeyRound, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { SearchProviderConfig, SearchProviderTemplate, WebResearchConfig, WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import { api } from "../api";
import { SecretInput } from "../components/secret-input";
import { useOnlineStatus } from "../use-online-status";

/** 呈现联网搜索的有序服务路由、凭证和网页读取策略。 */
export function WebResearchPage() {
  const online = useOnlineStatus();
  const [document, setDocument] = useState<WebResearchSettingsDocument>();
  const [draft, setDraft] = useState<WebResearchConfig>();
  const [expandedId, setExpandedId] = useState<string>();
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState("");
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretVisible, setSecretVisible] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api.getWebResearch().then((next) => {
      if (!active) return;
      setDocument(next);
      setDraft(next.config);
      setSelectedTemplateId(availableTemplates(next)[0]?.id ?? "");
    }).catch(() => { if (active) setMessage("无法读取联网搜索配置"); });
    return () => {
      active = false;
      // 页面卸载时主动丢弃已按需读取的凭证明文。
      setSecretValues({});
      setSecretVisible({});
    };
  }, []);

  const dirty = Boolean(document && draft && JSON.stringify(document.config) !== JSON.stringify(draft));
  const templates = useMemo(() => document ? availableTemplates({ ...document, config: draft ?? document.config }) : [], [document, draft]);
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0];

  const update = <Key extends keyof WebResearchConfig>(key: Key, value: WebResearchConfig[Key]) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  };
  const updateProvider = (providerId: string, patch: Partial<SearchProviderConfig>) => {
    setDraft((current) => current ? {
      ...current,
      searchProviders: current.searchProviders.map((provider) => provider.id === providerId ? { ...provider, ...patch } : provider),
    } : current);
  };
  const moveProvider = (providerId: string, offset: -1 | 1) => {
    setDraft((current) => {
      if (!current) return current;
      const index = current.searchProviders.findIndex((provider) => provider.id === providerId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= current.searchProviders.length) return current;
      const searchProviders = [...current.searchProviders];
      [searchProviders[index], searchProviders[target]] = [searchProviders[target]!, searchProviders[index]!];
      return { ...current, searchProviders };
    });
  };
  const clearSecrets = () => {
    setSecretValues({});
    setSecretVisible({});
  };
  const toggleExpanded = (providerId: string) => {
    clearSecrets();
    setExpandedId((current) => current === providerId ? undefined : providerId);
  };
  const save = async () => {
    if (!document || !draft) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await api.updateWebResearch(document.revision, draft);
      setDocument(next);
      setDraft(next.config);
      setMessage("已保存，联网工具将在 Runtime 刷新后生效");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally { setBusy(false); }
  };
  const addProvider = async () => {
    if (!document || !draft || !selectedTemplate) return;
    if (selectedTemplate.connectionMode === "custom" && !customBaseUrl.trim()) {
      setMessage("请先填写自定义 SearXNG 地址");
      return;
    }
    const provider: SearchProviderConfig = {
      id: nextProviderId(selectedTemplate, draft.searchProviders),
      name: selectedTemplate.name,
      type: selectedTemplate.type,
      connectionMode: selectedTemplate.connectionMode,
      enabled: selectedTemplate.type === "searxng",
      timeoutMs: 10_000,
      ...(selectedTemplate.connectionMode === "custom" ? { baseUrl: customBaseUrl.trim() } : {}),
    };
    setBusy(true);
    setMessage("");
    try {
      const next = await api.addWebResearchProvider(document.revision, provider);
      setDocument(next);
      setDraft(next.config);
      setExpandedId(provider.id);
      setCustomBaseUrl("");
      setSelectedTemplateId(availableTemplates(next)[0]?.id ?? "");
      setMessage("已添加搜索服务；直接 API 请先配置凭证再启用");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "添加搜索服务失败");
    } finally { setBusy(false); }
  };
  const removeProvider = async (provider: SearchProviderConfig) => {
    if (!document || !window.confirm(`删除“${provider.name}”及其已保存凭证？`)) return;
    setBusy(true);
    setMessage("");
    try {
      await api.deleteWebResearchProvider(provider.id, document.revision, document.credentialRevision);
      const next = await api.getWebResearch();
      clearSecrets();
      setExpandedId(undefined);
      setDocument(next);
      setDraft(next.config);
      setMessage("已删除搜索服务");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "删除搜索服务失败");
    } finally { setBusy(false); }
  };
  const testProvider = async (provider: SearchProviderConfig) => {
    setBusy(true);
    setMessage("");
    try { setMessage((await api.testWebResearchProvider(provider.id)).message); }
    catch (error) { setMessage(error instanceof Error ? error.message : "连接测试失败"); }
    finally { setBusy(false); }
  };
  const toggleSecret = async (provider: SearchProviderConfig, visible: boolean) => {
    if (!visible) {
      setSecretVisible((current) => ({ ...current, [provider.id]: false }));
      setSecretValues((current) => ({ ...current, [provider.id]: "" }));
      return;
    }
    try {
      let value = secretValues[provider.id] ?? "";
      if (!value && hasCredential(document, provider.id)) value = (await api.getWebResearchProviderCredential(provider.id)).apiKey;
      setSecretValues((current) => ({ ...current, [provider.id]: value }));
      setSecretVisible((current) => ({ ...current, [provider.id]: true }));
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取 API Key"); }
  };
  const saveCredential = async (provider: SearchProviderConfig) => {
    if (!document || !secretValues[provider.id]) return;
    setBusy(true);
    try {
      const result = await api.setWebResearchProviderCredential(provider.id, document.credentialRevision, secretValues[provider.id]!);
      setDocument((current) => current ? {
        ...current,
        credentialRevision: result.credentialRevision,
        credentials: [...current.credentials.filter((status) => status.providerId !== provider.id), ...(result.status ? [result.status] : [])],
      } : current);
      await toggleSecret(provider, false);
      setMessage("已保存 API Key");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存 API Key 失败"); }
    finally { setBusy(false); }
  };
  const removeCredential = async (provider: SearchProviderConfig) => {
    if (!document) return;
    setBusy(true);
    try {
      const result = await api.deleteWebResearchProviderCredential(provider.id, document.credentialRevision);
      setDocument((current) => current ? {
        ...current,
        credentialRevision: result.credentialRevision,
        credentials: current.credentials.filter((status) => status.providerId !== provider.id),
      } : current);
      await toggleSecret(provider, false);
      setMessage("已删除 API Key");
    } catch (error) { setMessage(error instanceof Error ? error.message : "删除 API Key 失败"); }
    finally { setBusy(false); }
  };
  const updateContentType = (contentType: "text/html" | "text/plain", enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const allowedContentTypes = enabled
        ? [...new Set([...current.allowedContentTypes, contentType])]
        : current.allowedContentTypes.filter((type) => type !== contentType);
      return allowedContentTypes.length > 0 ? { ...current, allowedContentTypes } : current;
    });
  };

  if (!draft || !document) return <main className="configuration-page"><p className="configuration-help">正在读取联网搜索配置…</p></main>;
  const enabledCount = draft.searchProviders.filter((provider) => provider.enabled).length;
  const missingCredential = draft.searchProviders.find((provider) => provider.enabled && provider.type !== "searxng" && !hasCredential(document, provider.id));
  return <main className="configuration-page web-research-page">
    <header className="configuration-page__heading"><h1>联网搜索</h1><p>搜索服务按管理员顺序自动故障切换；Agent 不能选择厂商或改写路由。</p></header>
    {message ? <p className="configuration-help" role="status">{message}</p> : null}
    <section className="configuration-form-card">
      <div className="configuration-section__heading"><div><span>01</span><h2>全局状态</h2></div><small>{enabledCount} 个已启用服务</small></div>
      <label className="configuration-capability-toggle"><span>启用联网搜索<small>启用后，已授权 Agent 才能使用工具。</small></span><input aria-label="启用联网搜索" type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} /></label>
      {draft.enabled && enabledCount === 0 ? <p className="configuration-inline-error" role="alert">至少启用一个搜索服务后才能保存。</p> : null}
      {draft.enabled && missingCredential ? <p className="configuration-inline-error" role="alert">请先为“{missingCredential.name}”配置 API Key，或停用该实例。</p> : null}
    </section>

    <section className="configuration-form-card web-research-providers">
      <div className="configuration-section__heading"><div><span>02</span><h2>搜索服务</h2></div><small>从上到下依次尝试</small></div>
      <div className="configuration-entry-list web-research-provider-list">
        {draft.searchProviders.map((provider, index) => <ProviderCard
          key={provider.id}
          provider={provider}
          index={index}
          total={draft.searchProviders.length}
          expanded={expandedId === provider.id}
          dirty={dirty}
          busy={busy}
          online={online}
          credentialConfigured={hasCredential(document, provider.id)}
          secretValue={secretValues[provider.id] ?? ""}
          secretVisible={secretVisible[provider.id] ?? false}
          egressProfiles={document.egressProfiles}
          onExpand={() => toggleExpanded(provider.id)}
          onMove={(offset) => moveProvider(provider.id, offset)}
          onUpdate={(patch) => updateProvider(provider.id, patch)}
          onTest={() => void testProvider(provider)}
          onRemove={() => void removeProvider(provider)}
          onSecretChange={(value) => setSecretValues((current) => ({ ...current, [provider.id]: value }))}
          onSecretVisibility={(visible) => void toggleSecret(provider, visible)}
          onSaveCredential={() => void saveCredential(provider)}
          onRemoveCredential={() => void removeCredential(provider)}
        />)}
        {draft.searchProviders.length === 0 ? <p className="configuration-help">尚未配置搜索服务。</p> : null}
      </div>
      {templates.length > 0 ? <div className="configuration-create-panel">
        <div className="configuration-create-panel__fields">
          <label><span>添加类型</span><select aria-label="搜索服务类型" value={selectedTemplate?.id ?? ""} onChange={(event) => { setSelectedTemplateId(event.target.value); setCustomBaseUrl(""); }}>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></label>
          {selectedTemplate?.connectionMode === "custom" ? <label><span>SearXNG 地址</span><input aria-label="新搜索服务地址" placeholder="https://search.example.com" value={customBaseUrl} onChange={(event) => setCustomBaseUrl(event.target.value)} /></label> : null}
        </div>
        <button type="button" className="configuration-secondary-action" aria-label="添加搜索服务" disabled={!online || busy || dirty} onClick={() => void addProvider()}><Plus size={15} aria-hidden="true" />添加</button>
        {dirty ? <small className="configuration-create-panel__onboarding">请先保存当前修改，再添加新实例。</small> : null}
      </div> : null}
    </section>

    <section className="configuration-form-card">
      <div className="configuration-section__heading"><div><span>03</span><h2>页面读取与资源限制</h2></div></div>
      <label><span>页面读取出口<small>出口地址、网段和凭证由部署环境管理。</small></span><select aria-label="页面读取出口" value={draft.webRead.egressProfileId} onChange={(event) => update("webRead", { ...draft.webRead, egressProfileId: event.target.value })}>{document.egressProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
      <label><span>页面读取超时（毫秒）</span><input aria-label="页面读取超时" type="number" min={1000} max={60000} value={draft.webRead.timeoutMs} onChange={(event) => update("webRead", { ...draft.webRead, timeoutMs: Number(event.target.value) })} /></label>
      <label><span>最大结果数</span><input aria-label="最大结果数" type="number" min={1} max={20} value={draft.maxResults} onChange={(event) => update("maxResults", Number(event.target.value))} /></label>
      <label><span>正文最大字符数<small>提取后的正文会在此长度处截断。</small></span><input aria-label="正文最大字符数" type="number" min={1000} max={100000} value={draft.maxTextLength} onChange={(event) => update("maxTextLength", Number(event.target.value))} /></label>
      <label><span>最大重定向次数</span><input aria-label="最大重定向次数" type="number" min={0} max={10} value={draft.maxRedirects} onChange={(event) => update("maxRedirects", Number(event.target.value))} /></label>
      <label><span>最大响应大小（MiB）<small>超过此大小的响应会被中止读取。</small></span><input aria-label="最大响应大小" type="number" min={0.0625} max={10} step={0.25} value={draft.maxResponseBytes / (1024 * 1024)} onChange={(event) => update("maxResponseBytes", Math.round(Number(event.target.value) * 1024 * 1024))} /></label>
    </section>

    <section className="configuration-form-card">
      <div className="configuration-section__heading"><div><span>04</span><h2>安全策略</h2></div></div>
      <label><span>仅允许 HTTPS<small>关闭后才允许读取普通 HTTP 公开网页。</small></span><input aria-label="仅允许 HTTPS" type="checkbox" checked={draft.httpsOnly} onChange={(event) => update("httpsOnly", event.target.checked)} /></label>
      <label><span>域名允许名单<small>每行一个域名；留空允许所有满足安全策略的公开网站。</small></span><textarea aria-label="域名允许名单" value={draft.allowedDomains.join("\n")} onChange={(event) => update("allowedDomains", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))} /></label>
      <label><span>允许 HTML 正文</span><input aria-label="允许 HTML 正文" type="checkbox" checked={draft.allowedContentTypes.includes("text/html")} onChange={(event) => updateContentType("text/html", event.target.checked)} /></label>
      <label><span>允许纯文本</span><input aria-label="允许纯文本" type="checkbox" checked={draft.allowedContentTypes.includes("text/plain")} onChange={(event) => updateContentType("text/plain", event.target.checked)} /></label>
    </section>
    <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" disabled={!online || busy || !dirty || (draft.enabled && (enabledCount === 0 || Boolean(missingCredential)))} onClick={() => void save()}><Save size={16} aria-hidden="true" />{busy ? "处理中…" : "保存更改"}</button></div>
  </main>;
}

interface ProviderCardProps {
  provider: SearchProviderConfig;
  index: number;
  total: number;
  expanded: boolean;
  dirty: boolean;
  busy: boolean;
  online: boolean;
  credentialConfigured: boolean;
  secretValue: string;
  secretVisible: boolean;
  egressProfiles: WebResearchSettingsDocument["egressProfiles"];
  onExpand(): void;
  onMove(offset: -1 | 1): void;
  onUpdate(patch: Partial<SearchProviderConfig>): void;
  onTest(): void;
  onRemove(): void;
  onSecretChange(value: string): void;
  onSecretVisibility(visible: boolean): void;
  onSaveCredential(): void;
  onRemoveCredential(): void;
}

/** 单个搜索实例卡片；标题区同时提供键盘可达的排序和展开操作。 */
function ProviderCard(props: ProviderCardProps) {
  const provider = props.provider;
  const needsCredential = provider.type !== "searxng";
  return <article className={props.expanded ? "web-research-provider is-expanded" : "web-research-provider"}>
    <header className="configuration-entry">
      <span className="web-research-provider__order">{String(props.index + 1).padStart(2, "0")}</span>
      <span><strong>{provider.name}</strong><small>{providerLabel(provider)} · {provider.connectionMode === "managed" ? "受管服务" : provider.enabled ? "已启用" : "已停用"}{needsCredential ? ` · ${props.credentialConfigured ? "凭证已配置" : "缺少凭证"}` : ""}</small></span>
      <div className="web-research-provider__actions">
        <button type="button" className="icon-button" aria-label={`上移${provider.name}`} disabled={props.index === 0 || props.busy} onClick={() => props.onMove(-1)}><ArrowUp size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={`下移${provider.name}`} disabled={props.index === props.total - 1 || props.busy} onClick={() => props.onMove(1)}><ArrowDown size={15} aria-hidden="true" /></button>
        <button type="button" className="icon-button" aria-label={`${props.expanded ? "收起" : "展开"}${provider.name}`} aria-expanded={props.expanded} onClick={props.onExpand}>{props.expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button>
      </div>
    </header>
    {props.expanded ? <div className="web-research-provider__details">
      <label><span>实例名称</span><input aria-label={`${provider.name}实例名称`} value={provider.name} onChange={(event) => props.onUpdate({ name: event.target.value })} /></label>
      <label className="configuration-capability-toggle"><span>参与搜索路由</span><input aria-label={`启用${provider.name}`} type="checkbox" checked={provider.enabled} onChange={(event) => props.onUpdate({ enabled: event.target.checked })} /></label>
      {provider.connectionMode === "custom" ? <label><span>SearXNG 地址</span><input aria-label={`${provider.name}地址`} value={provider.baseUrl ?? ""} onChange={(event) => props.onUpdate({ baseUrl: event.target.value })} /></label> : null}
      <label><span>请求超时（毫秒）</span><input aria-label={`${provider.name}请求超时`} type="number" min={1000} max={60000} value={provider.timeoutMs} onChange={(event) => props.onUpdate({ timeoutMs: Number(event.target.value) })} /></label>
      <label><span>联网出口</span><select aria-label={`${provider.name}联网出口`} value={provider.egressProfileId ?? "direct"} onChange={(event) => props.onUpdate({ egressProfileId: event.target.value })}>{props.egressProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>
      {needsCredential ? <label><span>API Key<small>{props.credentialConfigured ? "已保存；小眼睛按需读取" : "仅保存到服务端"}</small></span><SecretInput aria-label={`${provider.name} API Key`} autoComplete="new-password" placeholder={props.credentialConfigured ? "已配置" : "请输入 API Key"} value={props.secretValue} visible={props.secretVisible} onVisibilityChange={props.onSecretVisibility} onChange={(event) => props.onSecretChange(event.target.value)} /></label> : null}
      <footer className="configuration-button-row">
        <button type="button" className="configuration-secondary-action" aria-label={`测试${provider.name}`} title={props.dirty ? "请先保存当前修改" : undefined} disabled={!props.online || props.busy || props.dirty} onClick={props.onTest}>测试连接</button>
        {needsCredential ? <button type="button" className="configuration-secondary-action" disabled={!props.online || props.busy || !props.secretValue} onClick={props.onSaveCredential}><KeyRound size={14} aria-hidden="true" />保存 Key</button> : null}
        {needsCredential && props.credentialConfigured ? <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" title={provider.enabled ? "请先停用实例并保存" : undefined} disabled={!props.online || props.busy || provider.enabled} onClick={props.onRemoveCredential}>删除 Key</button> : null}
        <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!props.online || props.busy || props.dirty} onClick={props.onRemove}><Trash2 size={14} aria-hidden="true" />删除实例</button>
      </footer>
    </div> : null}
  </article>;
}

function hasCredential(document: WebResearchSettingsDocument | undefined, providerId: string): boolean {
  return document?.credentials.some((status) => status.providerId === providerId && status.configured) ?? false;
}

function providerLabel(provider: SearchProviderConfig): string {
  if (provider.type === "bocha") return "博查 Web Search";
  if (provider.type === "tavily") return "Tavily Search";
  return "SearXNG";
}

/** 受管模板只能添加一次；厂商与自定义模板允许创建多个实例。 */
function availableTemplates(document: Pick<WebResearchSettingsDocument, "providerTemplates" | "config">): SearchProviderTemplate[] {
  return document.providerTemplates.filter((template) => template.connectionMode !== "managed"
    || !document.config.searchProviders.some((provider) => provider.id === template.id));
}

function nextProviderId(template: SearchProviderTemplate, providers: SearchProviderConfig[]): string {
  if (template.connectionMode === "managed") return template.id;
  const base = template.type === "searxng" ? "searxng" : template.type;
  if (!providers.some((provider) => provider.id === base)) return base;
  let suffix = 2;
  while (providers.some((provider) => provider.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
