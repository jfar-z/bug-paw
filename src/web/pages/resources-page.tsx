import { Eye, PackagePlus, ShieldAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { api, type ResourceCatalog, type ResourceCatalogItem } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { TaskLog } from "../components/configuration/task-log";
import { ConfirmationDialog } from "../components/configuration/confirmation-dialog";
import { useOnlineStatus } from "../use-online-status";

/**
 * 展示核心资源目录、注册工具和经确认的安装任务。
 */
export function ResourcesPage() {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [catalog, setCatalog] = useState<ResourceCatalog>(); const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [agentId, setAgentId] = useState(""); const [type, setType] = useState("all"); const [source, setSource] = useState("all");
  const [content, setContent] = useState<{ name: string; text: string }>(); const [packageSource, setPackageSource] = useState(""); const [confirmed, setConfirmed] = useState(false); const [taskId, setTaskId] = useState(""); const [error, setError] = useState(""); const [packageToRemove, setPackageToRemove] = useState<NonNullable<ResourceCatalog["packages"]>[number]>();
  useEffect(() => { void runOptionalApiTask(api.listAgents, { operation: "加载资源 Agent 目录", fallbackReason: "Agent 目录不可用", fallback: () => ({ agents: [] }) }).then((result) => { if (result.status === "success" || result.status === "fallback") setAgents(result.data.agents); }); }, [runOptionalApiTask]);
  useEffect(() => { setCatalog(undefined); void runApiTask(() => api.listResources(agentId || undefined), { operation: "加载资源目录" }).then((result) => { if (result.status === "success") setCatalog(result.data); }); }, [agentId, runApiTask]);
  const visible = useMemo(() => catalog?.resources.filter((item) => (type === "all" || item.type === type) && (source === "all" || item.scope === source)) ?? [], [catalog, type, source]);
  async function view(item: ResourceCatalogItem) { const result = await runApiTask(() => api.getResourceContent(item.id, agentId || undefined), { operation: "查看资源内容", expected: resourceExpected(setError) }); if (result.status === "success") setContent({ name: item.name, text: result.data.content }); }
  async function changeMode(item: ResourceCatalogItem, mode: "enabled" | "disabled" | "inherit") { const result = await runApiTask(() => api.setResourceMode(item.id, mode, agentId ? "agent" : "global", agentId || undefined), { operation: "更新资源状态", expected: resourceExpected(setError) }); if (result.status === "success") setCatalog(result.data); }
  async function installPackage() { const result = await runApiTask(() => api.installResource(packageSource, agentId ? "agent" : "global", agentId || undefined), { operation: "安装扩展包", expected: resourceExpected(setError) }); if (result.status === "success") setTaskId(result.data.taskId); }
  async function removePackage() { if (!packageToRemove) return; const item = packageToRemove; const result = await runApiTask(() => api.removeResourcePackage(item.source, item.scope === "user" ? "global" : "agent", agentId || undefined), { operation: "卸载扩展包", expected: resourceExpected(setError) }); if (result.status === "success") { setPackageToRemove(undefined); setTaskId(result.data.taskId); } }
  return <div className="configuration-page resources-page"><header className="configuration-page__heading"><span className="configuration-eyebrow">RESOURCE CATALOG</span><h1>Skills 与扩展</h1><p>把 Skills、工具与扩展收拢在一起，让 BUG 随时找到可用的能力；第三方扩展可能以容器最大权限运行。</p><p className="configuration-help">资源变更完成后，请到系统诊断刷新核心配置后生效。</p></header>
    <div className="resource-filters"><label>Agent<select aria-label="资源 Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">全局工作区</option>{agents.map(({ profile }) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label><label>类型<select aria-label="资源类型" value={type} onChange={(event) => setType(event.target.value)}><option value="all">全部</option><option value="skill">Skills</option><option value="prompt">Prompts</option><option value="extension">Extensions</option><option value="theme">Themes</option></select></label><label>来源<select aria-label="资源来源" value={source} onChange={(event) => setSource(event.target.value)}><option value="all">全部</option><option value="global">Global</option><option value="agent">Agent</option></select></label></div>
    {error ? <p className="configuration-inline-error">{error}</p> : null}{catalog && catalog.resources.length === 0 ? <section className="resource-empty-state"><img src="/brand/bugpaw/bugpaw-sleeping.png" alt="BUG 正在等候第一项扩展" /><div><strong>BUG 还在等第一项扩展</strong><p>安装或启用一个 Skill、Prompt、Extension 或 Theme 后，它会出现在这里。</p></div></section> : null}{catalog && catalog.resources.length > 0 && visible.length === 0 ? <p className="resource-filter-empty">没有匹配的资源。</p> : null}<div className="resource-grid">{visible.map((item) => <article key={item.id}><header><span>{item.type}</span><small>{item.scope}{item.inherited ? " · 继承" : ""}</small></header><h2>{item.name}</h2><p>{item.description}</p><code>{item.path}</code><footer><button type="button" aria-label={`查看 ${item.name}`} onClick={() => void view(item)}><Eye size={14} aria-hidden="true" />查看</button><select aria-label={`${item.name} 状态`} disabled={!online} value={item.enabled ? "enabled" : "disabled"} onChange={(event) => void changeMode(item, event.target.value as "enabled" | "disabled" | "inherit")}><option value="enabled">启用</option><option value="disabled">屏蔽</option>{agentId && item.inherited ? <option value="inherit">继承</option> : null}</select></footer></article>)}</div>
    {content ? <section className="resource-content"><header><h2>{content.name}</h2><button type="button" onClick={() => setContent(undefined)}>关闭</button></header><pre>{content.text}</pre></section> : null}
    <section className="configuration-form-card resource-tools"><div className="configuration-section__heading"><div><span>TOOLS</span><h2>扩展注册工具</h2></div></div>{catalog?.tools.map((tool) => <div key={`${tool.extensionPath}:${tool.name}`}><strong>{tool.name}</strong><p>{tool.description}</p>{tool.highRisk ? <small><ShieldAlert size={13} aria-hidden="true" />高风险</small> : null}</div>)}</section>
    <section className="configuration-form-card resource-install"><div className="configuration-section__heading"><div><span>INSTALL</span><h2>扩展包</h2></div></div>{catalog?.packages?.map((item) => <div className="resource-package" key={`${item.scope}:${item.source}`}><span><strong>{item.source}</strong><small>{item.scope === "user" ? "global" : "agent"}{item.filtered ? " · 已过滤" : ""}</small></span><button type="button" disabled={!online} onClick={() => setPackageToRemove(item)}>卸载</button></div>)}<label><span>来源<small>npm:、git:、HTTPS 或容器内本地路径</small></span><input value={packageSource} onChange={(event) => { setPackageSource(event.target.value); setConfirmed(false); }} /></label><label className="resource-install__confirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span>我已审阅来源，并理解扩展会执行任意代码。</span></label><button type="button" className="configuration-primary-action" disabled={!confirmed || !packageSource.trim() || !online} onClick={() => void installPackage()}><PackagePlus size={16} aria-hidden="true" />开始安装</button>{taskId ? <TaskLog taskId={taskId} /> : null}</section>
    {packageToRemove ? <ConfirmationDialog title="确认卸载扩展包" description={`将卸载 ${packageToRemove.source}，此操作可能影响依赖该资源的 Agent。`} confirmLabel="确认卸载" onCancel={() => setPackageToRemove(undefined)} onConfirm={() => void removePackage()} /> : null}
  </div>;
}

/** 将资源管理的确认和状态冲突保留在当前页面。 */
function resourceExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    AGENT_NOT_FOUND: show,
    RESOURCE_ID_REQUIRED: show,
    RESOURCE_NOT_FOUND: show,
    INVALID_RESOURCE_MODE: show,
    PACKAGE_IN_USE: show,
    INSTALL_CONFIRMATION_REQUIRED: show,
    REMOVE_CONFIRMATION_REQUIRED: show,
    TASK_NOT_FOUND: show,
  };
}
