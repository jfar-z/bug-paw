import { ArrowRight } from "lucide-react";
import type { AppRoute } from "../router";
import "../configuration.css";

interface ConfigurationOverviewPageProps {
  onNavigate: (route: AppRoute) => void;
}

const configurationEntries: Array<{ title: string; description: string; route: AppRoute }> = [
  { title: "Agents", description: "创建 Agent，并设置工作目录、默认模型、工具与指令。", route: { page: "agents" } },
  { title: "模型与凭证", description: "管理 Provider、模型能力、兼容配置与访问凭证。", route: { page: "providers" } },
  { title: "运行设置", description: "调整默认模型与推理策略，让 BUG 的工作节奏保持一致。", route: { page: "pi-settings" } },
  { title: "Skills 与扩展", description: "查看并管理可用 Skills、工具与扩展来源。", route: { page: "resources" } },
  { title: "能力扩展", description: "配置联网搜索及后续接入的附加能力。", route: { page: "capabilities" } },
  { title: "系统诊断", description: "检查运行环境；调整后刷新核心配置，让新规则进入工作。", route: { page: "diagnostics" } },
];

/**
 * 呈现真实可用的配置入口，避免将占位状态误导为运行状态。
 */
export function ConfigurationOverviewPage({ onNavigate }: ConfigurationOverviewPageProps) {
  return (
    <div className="configuration-page configuration-overview-page">
      <header className="configuration-page__heading">
        <div>
          <h1>配置中心</h1>
          <p>把模型、规则和工作环境安顿好，让 BUG 专注继续工作。</p>
        </div>
        <img
          className="configuration-overview-mascot"
          src="/brand/bugpaw/bugpaw-mascot.png"
          alt="BUG 猫咪像素吉祥物"
        />
      </header>

      <section className="configuration-section" aria-labelledby="configuration-entry-title">
        <div className="configuration-section__heading">
          <div><span>01</span><h2 id="configuration-entry-title">从这里开始</h2></div>
        </div>
        <div className="configuration-entry-list">
          {configurationEntries.map((entry) => <button key={entry.title} type="button" className="configuration-entry" onClick={() => onNavigate(entry.route)}>
            <span><strong>{entry.title}</strong><small>{entry.description}</small></span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>)}
        </div>
      </section>
    </div>
  );
}
