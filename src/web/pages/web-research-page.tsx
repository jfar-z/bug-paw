import { useEffect, useState } from "react";
import type { WebResearchConfig, WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import { api } from "../api";
import { useOnlineStatus } from "../use-online-status";

/** 呈现联网搜索的连接、安全与资源配置。 */
export function WebResearchPage() {
  const online = useOnlineStatus();
  const [document, setDocument] = useState<WebResearchSettingsDocument>();
  const [draft, setDraft] = useState<WebResearchConfig>();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.getWebResearch().then((next) => { setDocument(next); setDraft(next.config); }).catch(() => setMessage("无法读取联网搜索配置")); }, []);
  const update = <Key extends keyof WebResearchConfig>(key: Key, value: WebResearchConfig[Key]) => setDraft((current) => current ? { ...current, [key]: value } : current);
  const updateContentType = (contentType: "text/html" | "text/plain", enabled: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const allowedContentTypes = enabled
        ? [...new Set([...current.allowedContentTypes, contentType])]
        : current.allowedContentTypes.filter((type) => type !== contentType);
      // 至少保留一种文本格式，避免提交后被服务端拒绝。
      return allowedContentTypes.length > 0 ? { ...current, allowedContentTypes } : current;
    });
  };
  const save = async () => { if (!document || !draft) return; setSaving(true); setMessage(""); try { const next = await api.updateWebResearch(document.revision, draft); setDocument(next); setDraft(next.config); setMessage("已保存，联网工具将在 Runtime 刷新后生效"); } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); } finally { setSaving(false); } };
  const test = async () => {
    const provider = draft?.searchProviders.find((candidate) => candidate.enabled);
    if (!provider) { setMessage("没有可测试的搜索服务"); return; }
    setSaving(true); setMessage("");
    try { setMessage((await api.testWebResearchProvider(provider.id)).message); }
    catch { setMessage("连接测试失败"); }
    finally { setSaving(false); }
  };
  if (!draft) return <main className="configuration-page"><p className="configuration-help">正在读取联网搜索配置…</p></main>;
  return <main className="configuration-page"><header className="configuration-page__heading"><h1>联网搜索</h1><p>只读取公开网页；内网、凭证和危险重定向始终受到服务端保护。</p></header>
    {message ? <p className="configuration-help" role="status">{message}</p> : null}
    <section className="configuration-form-card"><h2>连接设置</h2><label className="configuration-capability-toggle"><span>启用联网搜索<small>启用后，已授权 Agent 才能使用工具。</small></span><input aria-label="启用联网搜索" type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} /></label><label><span>SearXNG 地址</span><input aria-label="SearXNG 地址" value={draft.searxngBaseUrl} onChange={(event) => update("searxngBaseUrl", event.target.value)} /></label><label><span>联网出口<small>出口地址、网段和凭证由部署环境管理。</small></span><select aria-label="联网出口" value={draft.egressProfileId} onChange={(event) => update("egressProfileId", event.target.value)}>{(document?.egressProfiles ?? [{ id: "direct", label: "直接访问" }]).map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label></section>
    <section className="configuration-form-card"><h2>资源限制</h2><label><span>最大结果数</span><input aria-label="最大结果数" type="number" min={1} max={20} value={draft.maxResults} onChange={(event) => update("maxResults", Number(event.target.value))} /></label><label><span>正文最大字符数<small>提取后的正文会在此长度处截断。</small></span><input aria-label="正文最大字符数" type="number" min={1000} max={100000} value={draft.maxTextLength} onChange={(event) => update("maxTextLength", Number(event.target.value))} /></label><label><span>请求超时（毫秒）</span><input aria-label="请求超时" type="number" min={1000} max={60000} value={draft.timeoutMs} onChange={(event) => update("timeoutMs", Number(event.target.value))} /></label><label><span>最大重定向次数</span><input aria-label="最大重定向次数" type="number" min={0} max={10} value={draft.maxRedirects} onChange={(event) => update("maxRedirects", Number(event.target.value))} /></label><label><span>最大响应大小（MiB）<small>超过此大小的响应会被中止读取。</small></span><input aria-label="最大响应大小" type="number" min={0.0625} max={10} step={0.25} value={draft.maxResponseBytes / (1024 * 1024)} onChange={(event) => update("maxResponseBytes", Math.round(Number(event.target.value) * 1024 * 1024))} /></label></section>
    <section className="configuration-form-card"><h2>安全策略</h2><label><span>仅允许 HTTPS<small>关闭后才允许读取普通 HTTP 公开网页。</small></span><input aria-label="仅允许 HTTPS" type="checkbox" checked={draft.httpsOnly} onChange={(event) => update("httpsOnly", event.target.checked)} /></label><label><span>域名允许名单<small>每行一个域名；留空允许所有满足安全策略的公开网站。</small></span><textarea aria-label="域名允许名单" value={draft.allowedDomains.join("\n")} onChange={(event) => update("allowedDomains", event.target.value.split("\n").map((value) => value.trim()).filter(Boolean))} /></label><label><span>允许 HTML 正文</span><input aria-label="允许 HTML 正文" type="checkbox" checked={draft.allowedContentTypes.includes("text/html")} onChange={(event) => updateContentType("text/html", event.target.checked)} /></label><label><span>允许纯文本</span><input aria-label="允许纯文本" type="checkbox" checked={draft.allowedContentTypes.includes("text/plain")} onChange={(event) => updateContentType("text/plain", event.target.checked)} /></label></section>
    <div className="configuration-save-bar"><button type="button" className="configuration-secondary-action" onClick={() => void test()} disabled={!online || saving}>测试连接</button><button type="button" className="configuration-primary-action" onClick={() => void save()} disabled={!online || saving}>{saving ? "处理中…" : "保存更改"}</button></div>
  </main>;
}
