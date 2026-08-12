import { Plus, Save, ServerCog, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { BrowserAutomationConfig, BrowserAutomationSettingsDocument, BrowserGrantedPermission, TrustedBrowserOrigin } from "../../shared/browser-automation-contracts";
import { api, ApiClientError } from "../api";
import { SettingsSection } from "../components/configuration/settings-section";
import { useOnlineStatus } from "../use-online-status";

const OFFLINE_KEY = "bugpaw:browser-automation:offline:v1";

/** 管理自托管 Playwright 的服务、边界、资源和浏览产物策略。 */
export function BrowserAutomationPage() {
  const browserOnline = useOnlineStatus();
  const [document, setDocument] = useState<BrowserAutomationSettingsDocument>();
  const [draft, setDraft] = useState<BrowserAutomationConfig>();
  const [origin, setOrigin] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let active = true;
    void api.getBrowserAutomation().then((next) => {
      if (!active) return;
      applyDocument(next);
      window.localStorage.setItem(OFFLINE_KEY, JSON.stringify({ revision: next.revision, config: next.config, savedAt: new Date().toISOString() }));
    }).catch(() => {
      if (!active) return;
      const cached = readOfflineSnapshot();
      if (cached) {
        setDocument({ ...cached, deployment: { available: false, workerAvailable: false, chromiumReady: false, activeContexts: 0, queuedRequests: 0 } });
        setDraft(structuredClone(cached.config));
        setOffline(true);
      } else setError("无法读取浏览器执行配置");
    });
    return () => { active = false; };

    function applyDocument(next: BrowserAutomationSettingsDocument) {
      setDocument(next);
      setDraft(structuredClone(next.config));
      setOffline(false);
    }
  }, []);

  const dirty = useMemo(() => Boolean(document && draft && JSON.stringify(document.config) !== JSON.stringify(draft)), [document, draft]);
  if (!document || !draft) return <main className="configuration-page"><p className={error ? "configuration-inline-error" : "configuration-help"}>{error || "正在读取浏览器执行配置…"}</p></main>;

  const patch = (next: Partial<BrowserAutomationConfig>) => { setDraft({ ...draft, ...next }); setNotice(""); setError(""); };
  const save = async () => {
    if (!dirty || offline || !browserOnline) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const next = await api.updateBrowserAutomation(document.revision, draft);
      setDocument(next); setDraft(structuredClone(next.config)); setNotice("浏览器设置已保存");
      window.localStorage.setItem(OFFLINE_KEY, JSON.stringify({ revision: next.revision, config: next.config, savedAt: new Date().toISOString() }));
    } catch (reason) {
      setError(reason instanceof ApiClientError && reason.code === "VERSION_CONFLICT" ? "配置已在其他页面更新，请刷新后重新应用更改。" : "保存浏览器设置失败");
    } finally { setSaving(false); }
  };

  const addOrigin = () => {
    try {
      const normalized = new URL(origin).origin;
      if (new URL(origin).href !== `${normalized}/` || draft.trustedOrigins.some((item) => item.origin === normalized)) throw new Error();
      patch({ trustedOrigins: [...draft.trustedOrigins, { origin: normalized, allowTextInput: false, allowFormSubmit: false, allowFileUpload: false, grantedPermissions: [] }] });
      setOrigin("");
    } catch { setError("请输入不含路径、查询或通配符的精确 HTTP(S) Origin"); }
  };

  return <main className="configuration-page browser-automation-page">
    <header className="configuration-page__heading"><h1>浏览器执行</h1><p>由现有 Agent 直接控制隔离的 Playwright；第一期支持只读游览、静态页面验证、截图与文件下载。</p></header>
    {offline ? <p className="configuration-save-notice" role="status">离线只读 · 显示上次保存的本地快照，测试与保存已暂停。</p> : null}
    {!document.deployment.available ? <p className="configuration-inline-error" role="alert">当前部署未包含浏览器组件。请使用 browser 或 full 部署组合后再启用。</p> : null}

    <SettingsSection index={1} title="服务状态" description="不显示 Context 或 Agent 身份">
      <label className="configuration-capability-toggle"><span>启用浏览器执行<small>启用后，仍只有获得对应工具权限的 Agent 可以调用。</small></span><input aria-label="启用浏览器执行" type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.target.checked })} /></label>
      <div className="agent-card__metadata"><span>{document.deployment.workerAvailable ? "Worker 可用" : "Worker 不可用"}</span><span>{document.deployment.activeContexts} 个活动 Context</span><span>{document.deployment.queuedRequests} 个排队任务</span></div>
      <button type="button" className="configuration-secondary-action" disabled={offline || !browserOnline || !document.deployment.available} onClick={() => void api.testBrowserAutomation().then((result) => setNotice(result.message)).catch(() => setError("浏览器组件测试失败"))}><ServerCog size={16} aria-hidden="true" />测试浏览器组件</button>
    </SettingsSection>

    <SettingsSection index={2} title="公开浏览范围" description="固定 HTTPS；空清单允许全部公网站点">
      <div className="configuration-empty-note"><p><strong>所有公网 HTTPS 站点</strong><small>私网、回环、链路本地、云元数据和重绑定地址始终由受控出口拒绝。</small></p></div>
      <div><NumberField label="导航超时（秒）" value={draft.publicBrowsing.navigationTimeoutMs / 1000} min={10} max={120} onChange={(value) => patch({ publicBrowsing: { ...draft.publicBrowsing, navigationTimeoutMs: value * 1000 } })} /><NumberField label="单 Run 打开上限" value={draft.publicBrowsing.maxPagesPerRun} min={1} max={100} onChange={(value) => patch({ publicBrowsing: { ...draft.publicBrowsing, maxPagesPerRun: value } })} /></div>
    </SettingsSection>

    <SettingsSection index={3} title="受信任 UI 验证" description="交互权限按精确 Origin 生效">
      <div className="configuration-create-panel"><label><span>精确 Origin</span><input aria-label="新增受信任 Origin" value={origin} placeholder="https://ui.example.com" onChange={(event) => setOrigin(event.target.value)} /></label><button type="button" className="configuration-secondary-action" onClick={addOrigin}><Plus size={15} aria-hidden="true" />添加 Origin</button></div>
      {draft.trustedOrigins.length === 0 ? <p className="configuration-help">尚未信任任何 UI Origin；公开网页只能只读游览。</p> : <div className="settings-groups">{draft.trustedOrigins.map((item, index) => <OriginCard key={item.origin} value={item} onChange={(next) => patch({ trustedOrigins: draft.trustedOrigins.map((candidate, candidateIndex) => candidateIndex === index ? next : candidate) })} onRemove={() => patch({ trustedOrigins: draft.trustedOrigins.filter((_, candidateIndex) => candidateIndex !== index) })} />)}</div>}
    </SettingsSection>

    <SettingsSection index={4} title="本地静态页面" description="预览当前 Agent 工作区 HTML">
      <PermissionSwitches value={draft.localPreview} onChange={(localPreview) => patch({ localPreview })} />
      <p className="configuration-help">不会挂载整个工作区，也不使用 file://；路径穿越和符号链接会被拒绝。</p>
    </SettingsSection>

    <SettingsSection index={5} title="资源池" description="默认值适配本地慢模型">
      <div><NumberField label="全局 Context" value={draft.pool.maxContexts} min={1} max={4} onChange={(value) => patch({ pool: { ...draft.pool, maxContexts: value } })} /><NumberField label="队列容量" value={draft.pool.queueCapacity} min={1} max={50} onChange={(value) => patch({ pool: { ...draft.pool, queueCapacity: value } })} /><NumberField label="排队等待（分钟）" value={draft.pool.queueWaitMs / 60_000} min={1} max={60} onChange={(value) => patch({ pool: { ...draft.pool, queueWaitMs: value * 60_000 } })} /><NumberField label="孤儿回收（分钟）" value={draft.pool.orphanTimeoutMs / 60_000} min={5} max={60} onChange={(value) => patch({ pool: { ...draft.pool, orphanTimeoutMs: value * 60_000 } })} /><NumberField label="Run 总时限（分钟）" value={draft.pool.runTimeoutMs / 60_000} min={15} max={180} onChange={(value) => patch({ pool: { ...draft.pool, runTimeoutMs: value * 60_000 } })} /></div>
    </SettingsSection>

    <SettingsSection index={6} title="浏览产物" description="仅写入当前 Agent 工作区">
      <div><NumberField label="截图数 / Run" value={draft.artifacts.maxScreenshotsPerRun} min={1} max={50} onChange={(value) => patch({ artifacts: { ...draft.artifacts, maxScreenshotsPerRun: value } })} /><NumberField label="下载数 / Run" value={draft.artifacts.maxDownloadsPerRun} min={0} max={30} onChange={(value) => patch({ artifacts: { ...draft.artifacts, maxDownloadsPerRun: value } })} /><NumberField label="单文件下载（MiB）" value={draft.artifacts.maxDownloadBytes / 1024 / 1024} min={1} max={100} onChange={(value) => patch({ artifacts: { ...draft.artifacts, maxDownloadBytes: value * 1024 * 1024 } })} /></div>
      <p className="configuration-help">可执行文件、安装包、脚本包和未知二进制默认拒绝；manifest 不记录页面正文、输入、Cookie 或请求头。</p>
    </SettingsSection>

    {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}{notice ? <p className="configuration-help" role="status">{notice}</p> : null}
    <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" disabled={!dirty || saving || offline || !browserOnline} onClick={() => void save()}><Save size={16} aria-hidden="true" />{saving ? "保存中…" : "保存浏览器设置"}</button></div>
  </main>;
}

function OriginCard({ value, onChange, onRemove }: { value: TrustedBrowserOrigin; onChange: (value: TrustedBrowserOrigin) => void; onRemove: () => void }) {
  return <article className="configuration-form-card"><header className="configuration-section__heading"><strong>{value.origin}</strong><button type="button" className="icon-button" aria-label={`删除 ${value.origin}`} onClick={onRemove}><Trash2 size={15} aria-hidden="true" /></button></header><PermissionSwitches value={value} onChange={(next) => onChange({ ...value, ...next })} /></article>;
}

function PermissionSwitches({ value, onChange }: { value: Omit<TrustedBrowserOrigin, "origin">; onChange: (value: Omit<TrustedBrowserOrigin, "origin">) => void }) {
  const permissions: Array<{ permission: BrowserGrantedPermission; label: string }> = [
    { permission: "clipboard-read", label: "允许读取剪贴板" },
    { permission: "clipboard-write", label: "允许写入剪贴板" },
  ];
  const togglePermission = (permission: BrowserGrantedPermission, enabled: boolean) => {
    const grantedPermissions = enabled
      ? [...new Set([...value.grantedPermissions, permission])]
      : value.grantedPermissions.filter((candidate) => candidate !== permission);
    onChange({ ...value, grantedPermissions });
  };
  return <div className="tool-permission-grid">
    {([{ key: "allowTextInput", label: "允许文本输入" }, { key: "allowFormSubmit", label: "允许表单提交" }, { key: "allowFileUpload", label: "允许文件上传" }] as const).map(({ key, label }) => <label key={key}><input aria-label={label} type="checkbox" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} /><span>{label}</span></label>)}
    {permissions.map(({ permission, label }) => <label key={permission}><input aria-label={label} type="checkbox" checked={value.grantedPermissions.includes(permission)} onChange={(event) => togglePermission(permission, event.target.checked)} /><span>{label}</span></label>)}
  </div>;
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input aria-label={label} type="number" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function readOfflineSnapshot(): { revision: string; config: BrowserAutomationConfig } | undefined {
  try {
    const value = JSON.parse(window.localStorage.getItem(OFFLINE_KEY) ?? "null") as { revision?: unknown; config?: unknown } | null;
    if (typeof value?.revision !== "string" || typeof value.config !== "object" || value.config === null) return undefined;
    return { revision: value.revision, config: value.config as BrowserAutomationConfig };
  } catch { return undefined; }
}
