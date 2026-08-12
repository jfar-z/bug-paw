import { ArrowRight, BrainCircuit, Globe2, MonitorPlay, Volume2 } from "lucide-react";
import type { AppRoute } from "../router";

interface CapabilitiesPageProps { onNavigate: (route: AppRoute) => void }

/** 展示独立于 Pi SDK 的可配置能力。 */
export function CapabilitiesPage({ onNavigate }: CapabilitiesPageProps) {
  return <div className="configuration-page">
    <header className="configuration-page__heading"><h1>能力扩展</h1><p>把联网搜索、语音与知识能力集中配置，并保持它们与 Pi 原生设置分离。</p></header>
    <section className="configuration-section" aria-labelledby="capability-list-title"><div className="configuration-section__heading"><div><span>01</span><h2 id="capability-list-title">已接入能力</h2></div></div><div className="configuration-entry-list"><button type="button" className="configuration-entry" onClick={() => onNavigate({ page: "browser-automation" })}><MonitorPlay size={18} aria-hidden="true" /><span><strong>浏览器执行</strong><small>由 Agent 直接控制隔离 Playwright，支持只读游览、静态页面验证、截图和下载。</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className="configuration-entry" onClick={() => onNavigate({ page: "web-research" })}><Globe2 size={18} aria-hidden="true" /><span><strong>联网搜索</strong><small>使用受管 SearXNG 搜索公开网页，并由 Agent 按权限读取正文。</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className="configuration-entry" onClick={() => onNavigate({ page: "tts" })}><Volume2 size={18} aria-hidden="true" /><span><strong>语音合成</strong><small>管理多个 OpenAI Speech 兼容接口，供 Agent 回答播放使用。</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className="configuration-entry" onClick={() => onNavigate({ page: "knowledge-retrieval" })}><BrainCircuit size={18} aria-hidden="true" /><span><strong>Embedding 与语义检索</strong><small>配置一个 Embedding 模型，并手动重建知识库的语义索引。</small></span><ArrowRight size={18} aria-hidden="true" /></button></div></section>
  </div>;
}
