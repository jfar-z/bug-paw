import { Activity, AlertTriangle, CheckCircle2, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { api, type DiagnosticsReport } from "../api";
import { ConfirmationDialog } from "../components/configuration/confirmation-dialog";

const FRONTEND_RELOAD_DELAY_MS = 500;

interface DiagnosticsPageProps {
  /** 刷新 Pi 配置成功后重新加载前端页面，便于测试时替换浏览器刷新行为。 */
  reloadPage?: () => void;
}

/**
 * 展示服务端实时生成且已脱敏的运行诊断。
 */
export function DiagnosticsPage({ reloadPage = () => window.location.reload() }: DiagnosticsPageProps) {
  const [report, setReport] = useState<DiagnosticsReport>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshingRuntime, setRefreshingRuntime] = useState(false);
  const [refreshConfirmationOpen, setRefreshConfirmationOpen] = useState(false);
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setReport(await api.getDiagnostics()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "诊断失败"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * 中断活动会话后重新加载 Pi 运行时配置，并刷新当前诊断报告。
   */
  const refreshPiRuntime = async () => {
    setRefreshConfirmationOpen(false);
    setRefreshingRuntime(true);
    setError("");
    setNotice("");
    try {
      const { abortedSessions } = await api.refreshPiRuntime();
      setNotice(`已中断 ${abortedSessions} 个活动会话并刷新核心配置，正在刷新页面…`);
      await refresh();
      // 短暂保留成功提示，避免页面立即切换而让用户误以为操作未生效。
      window.setTimeout(reloadPage, FRONTEND_RELOAD_DELAY_MS);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "核心配置刷新失败");
    } finally {
      setRefreshingRuntime(false);
    }
  };

  return <div className="configuration-page diagnostics-page">
    <header className="configuration-page__heading configuration-heading-actions"><div><span className="configuration-eyebrow">SYSTEM DIAGNOSTICS</span><h1>系统诊断</h1><p>检查模型、凭证、目录、挂载和资源加载状态，让 BUG 的运行环境保持就绪。</p></div><div className="configuration-button-row"><button type="button" className="secondary-button" onClick={() => void refresh()} disabled={loading || refreshingRuntime}><RefreshCw size={16} aria-hidden="true" />刷新诊断</button><button type="button" className="danger-button" onClick={() => setRefreshConfirmationOpen(true)} disabled={loading || refreshingRuntime}><RefreshCw size={16} aria-hidden="true" />刷新核心配置</button></div></header>
    {loading && !report ? <section className="configuration-form-card">正在执行诊断…</section> : null}
    {error ? <section className="configuration-error-state" role="alert">{error}</section> : null}
    {notice ? <p className="configuration-save-notice" role="status">{notice}</p> : null}
    {report ? <>
      <section className="diagnostics-version-strip" aria-label="版本信息"><div><strong>{report.version.app}</strong><small>Web Agent</small></div><div><strong>{report.version.pi}</strong><small>核心运行时</small></div><div><strong>{report.version.node}</strong><small>Node.js</small></div></section>
      <section className="configuration-form-card"><h2><Server size={18} aria-hidden="true" />持久化挂载</h2><div className="diagnostics-list">{report.mounts.length ? report.mounts.map((mount) => <div key={`${mount.source}:${mount.target}`}>{mount.writable ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}<span><strong>{mount.source} → {mount.target}</strong><small>{mount.writable ? "可写" : "只读"}</small></span></div>) : <p>未检测到对应挂载。</p>}</div></section>
      <section className="configuration-form-card"><h2><Activity size={18} aria-hidden="true" />检查结果</h2><div className="diagnostics-list">{report.diagnostics.length ? report.diagnostics.map((item, index) => <div className={`is-${item.severity}`} key={`${item.code}-${index}`}>{item.severity === "error" || item.severity === "warning" ? <AlertTriangle size={18} aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}<span><strong>{item.message}</strong><small>{item.code}{item.field ? ` · ${item.field}` : ""}</small></span></div>) : <div><CheckCircle2 size={18} aria-hidden="true" /><span><strong>未发现配置问题</strong><small>所有只读检查均通过</small></span></div>}</div></section>
    </> : null}
    {refreshConfirmationOpen ? <ConfirmationDialog title="确认刷新核心配置" description="这会立即停止所有正在生成的对话，并重新加载核心运行配置。" confirmLabel="继续刷新" busy={refreshingRuntime} onCancel={() => setRefreshConfirmationOpen(false)} onConfirm={() => void refreshPiRuntime()} /> : null}
  </div>;
}
