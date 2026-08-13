import { Check, ChevronsUpDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { AgentAvatar } from "./agent-avatar";

interface AgentModelMenuProps {
  agents?: AgentProfileDocument[];
  agent?: { id: string; name: string; avatarText: string };
  selectedAgentId?: string;
  disabled?: boolean;
  onSelectAgent?: (agentId: string) => void;
}

/**
 * 选择当前对话的 Agent，模型选择由输入区独立承载。
 */
export function AgentModelMenu({ agents = [], agent, selectedAgentId, disabled, onSelectAgent }: AgentModelMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedAgent = agents.find((item) => item.profile.id === selectedAgentId);
  const title = selectedAgent?.profile.name ?? agent?.name ?? "选择 Agent";

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <div className="agent-model-menu" ref={rootRef}>
    <button type="button" className="agent-model-menu__trigger" aria-label="切换 Agent" aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen((value) => !value)}>
      {selectedAgent ? <AgentAvatar agent={selectedAgent} className="agent-model-menu__avatar" /> : <span className="agent-model-menu__avatar">{agent?.avatarText ?? "?"}</span>}
      <span className="agent-model-menu__current"><strong>{title}</strong></span>
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
    </div> : null}
  </div>;
}
