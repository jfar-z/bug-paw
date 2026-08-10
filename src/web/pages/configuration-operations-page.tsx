import { Download, FileClock, RotateCcw, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, type ConfigurationHistoryEntry, type ConfigurationImportPreview } from "../api";
import { ConfirmationDialog } from "../components/configuration/confirmation-dialog";
import { useOnlineStatus } from "../use-online-status";

/**
 * 提供安全导出、先预览后确认的导入，以及可审阅的设置历史恢复。
 */
export function ConfigurationOperationsPage() {
  const online = useOnlineStatus();
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ConfigurationImportPreview>();
  const [history, setHistory] = useState<ConfigurationHistoryEntry[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [restoreEntry, setRestoreEntry] = useState<ConfigurationHistoryEntry>();
  const refreshHistory = useCallback(async () => {
    try {
      setHistory((await api.listConfigurationHistory()).entries);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "配置历史加载失败");
    }
  }, []);
  useEffect(() => { void refreshHistory(); }, [refreshHistory]);

  const createPreview = async () => {
    setMessage("");
    try {
      const value = JSON.parse(source) as unknown;
      setPreview(await api.previewConfigurationImport(value));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "JSON 无法解析");
    }
  };
  const apply = async () => {
    if (!preview) return;
    setBusy(true);
    try { await api.applyConfigurationImport(preview.previewId); setMessage("配置导入完成"); setPreview(undefined); await refreshHistory(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "导入失败"); }
    finally { setBusy(false); }
  };
  const restore = async () => {
    if (!restoreEntry) return;
    const entry = restoreEntry;
    setRestoreEntry(undefined);
    setBusy(true);
    try {
      const current = entry.scope === "agent" && entry.targetId ? await api.getAgentSettings(entry.targetId) : await api.getGlobalSettings();
      await api.restoreConfigurationHistory(entry.id, current.revision);
      setMessage("历史设置已恢复");
      await refreshHistory();
    } catch (error) { setMessage(error instanceof Error ? error.message : "恢复失败"); }
    finally { setBusy(false); }
  };

  const blocked = !preview || preview.invalid.length > 0 || preview.conflicts.length > 0;
  return <div className="configuration-page configuration-operations-page">
    <header className="configuration-page__heading"><span className="configuration-eyebrow">IMPORT · EXPORT · HISTORY</span><h1>导入与变更</h1><p>导出默认排除 auth.json、应用密码和 Header 敏感值；导入必须先预览，再明确确认。</p><p className="configuration-help">导入或恢复只保存文件；请到系统诊断刷新核心配置后生效。</p></header>
    {message ? <div className="configuration-inline-message" role="status">{message}</div> : null}
    <section className="configuration-form-card operations-export"><div><h2><Download size={18} aria-hidden="true" />安全导出</h2><p>生成可审阅的 JSON 配置包，不包含凭证明文。</p></div><a className="secondary-button" href="/api/v1/configuration/export" download aria-disabled={!online}>下载配置包</a></section>
    <section className="configuration-form-card"><h2><Upload size={18} aria-hidden="true" />导入预览</h2><label className="configuration-field"><span>配置包或标准模型配置文件</span><textarea value={source} onChange={(event) => { setSource(event.target.value); setPreview(undefined); }} rows={10} spellCheck={false} placeholder="粘贴 JSON 内容" /></label><div className="configuration-actions"><button type="button" className="secondary-button" onClick={() => void createPreview()} disabled={!source.trim() || busy || !online}>生成预览</button><button type="button" className="primary-button" onClick={() => void apply()} disabled={blocked || busy || !online}>确认并应用</button></div>
      {preview ? <div className="import-preview" aria-label="导入预览结果"><PreviewGroup label="新增" values={preview.added} /><PreviewGroup label="变更" values={preview.changed} /><PreviewGroup label="冲突" values={preview.conflicts} /><PreviewGroup label="无效" values={preview.invalid.map((item) => `${item.file}: ${item.message}`)} /></div> : null}
    </section>
    <section className="configuration-form-card"><h2><FileClock size={18} aria-hidden="true" />变更历史</h2><div className="configuration-history-list">{history.length ? history.map((entry) => <div key={entry.id}><span><strong>{entry.summary}</strong><small>{new Date(entry.createdAt).toLocaleString()} · {entry.scope}</small></span>{entry.restorable ? <button type="button" className="text-button" onClick={() => setRestoreEntry(entry)} disabled={busy || !online}><RotateCcw size={15} aria-hidden="true" />恢复</button> : <small>仅审计</small>}</div>) : <p>尚无配置变更记录。</p>}</div></section>
    {restoreEntry ? <ConfirmationDialog title="确认恢复配置" description="恢复会重新校验快照，并要求当前 revision 未变化。" confirmLabel="继续恢复" busy={busy} onCancel={() => setRestoreEntry(undefined)} onConfirm={() => void restore()} /> : null}
  </div>;
}

function PreviewGroup({ label, values }: { label: string; values: string[] }) {
  return <div><strong>{label} · {values.length}</strong>{values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <small>无</small>}</div>;
}
