import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import type { ModelSummary } from "../api";
import { AgentAvatar } from "./agent-avatar";

interface AgentModelMenuProps {
  agents?: AgentProfileDocument[];
  agent?: { id: string; name: string; avatarText: string };
  selectedAgentId?: string;
  models: ModelSummary[];
  selectedModel?: ModelSummary;
  disabled?: boolean;
  onSelectAgent?: (agentId: string) => void;
  onSelectModel?: (model: ModelSummary) => void;
  onSelect?: (model: ModelSummary) => void;
}

/**
 * 在同一个菜单中选择当前对话的 Agent 与模型。
 */
export function AgentModelMenu({ agents = [], agent, selectedAgentId, models, selectedModel, disabled, onSelectAgent, onSelectModel, onSelect }: AgentModelMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedAgent = agents.find((item) => item.profile.id === selectedAgentId);
  const title = selectedAgent?.profile.name ?? agent?.name ?? "选择 Agent";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return <div className="agent-model-menu" ref={rootRef}>
    <button type="button" className="agent-model-menu__trigger" aria-label="切换 Agent 或模型" aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen((value) => !value)}>
      {selectedAgent ? <AgentAvatar agent={selectedAgent} className="agent-model-menu__avatar" /> : <span className="agent-model-menu__avatar">{agent?.avatarText ?? "?"}</span>}
      <span className="agent-model-menu__current"><strong>{title}</strong><small>{selectedModel?.name ?? "选择模型"}</small></span>
      <ChevronsUpDown size={15} aria-hidden="true" />
    </button>
    {open ? <div className="agent-model-menu__popover">
      {agents.length > 0 ? <div className="agent-model-menu__options" role="listbox" aria-label="可用 Agent">
        {agents.map((agent) => <button key={agent.profile.id} type="button" className="agent-model-menu__agent-option" role="option" aria-selected={agent.profile.id === selectedAgentId} onClick={() => { onSelectAgent?.(agent.profile.id); setOpen(false); }}>
          <AgentAvatar agent={agent} className="agent-model-menu__avatar" />
          <span><strong>{agent.profile.name}</strong><small>{agent.profile.cwd}</small></span>
          {agent.profile.id === selectedAgentId ? <Check size={16} aria-hidden="true" /> : null}
        </button>)}
      </div> : null}
      <div className="agent-model-menu__options" role="listbox" aria-label="可用模型">
        {models.length === 0 ? <p className="agent-model-menu__empty">暂无可用模型</p> : models.map((model) => <button key={`${model.provider}:${model.id}`} type="button" role="option" aria-selected={sameModel(model, selectedModel)} onClick={() => { onSelectModel?.(model); onSelect?.(model); setOpen(false); }}>
          <span><strong>{model.name}</strong><small>{model.provider} · {model.id}</small></span>
          {sameModel(model, selectedModel) ? <Check size={16} aria-hidden="true" /> : null}
        </button>)}
      </div>
    </div> : null}
  </div>;
}

function sameModel(left: ModelSummary, right?: ModelSummary): boolean {
  return left.provider === right?.provider && left.id === right.id;
}
