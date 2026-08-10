import { Database, File, Folder, WandSparkles, X } from "lucide-react";
import type { AgentReference } from "../../shared/agent-reference-contracts";

interface AgentReferenceChipsProps {
  references: AgentReference[];
  removable?: boolean;
  onRemove?: (reference: AgentReference) => void;
}

/**
 * 以类型独立的视觉标签展示用户显式引用的 Agent 资源。
 */
export function AgentReferenceChips({ references, removable = false, onRemove }: AgentReferenceChipsProps) {
  if (references.length === 0) return null;
  return (
    <div className="agent-reference-chips" aria-label="消息引用">
      {references.map((reference) => {
        const meta = referenceMeta(reference);
        const key = reference.type === "skill" ? `skill:${reference.name}` : reference.type === "knowledge" ? `knowledge:${reference.id}` : `file:${reference.path}`;
        const Icon = meta.icon;
        return (
          <span key={key} className={`agent-reference-chip agent-reference-chip--${reference.type}${reference.type === "file" ? ` is-${reference.kind}` : ""}`} aria-label={`${meta.label}：${meta.name}`}>
            <Icon size={13} aria-hidden="true" />
            <span>{meta.name}</span>
            {removable && onRemove ? <button type="button" aria-label={`移除引用 ${meta.name}`} onClick={() => onRemove(reference)}><X size={12} /></button> : null}
          </span>
        );
      })}
    </div>
  );
}

function referenceMeta(reference: AgentReference): { label: string; name: string; icon: typeof File } {
  if (reference.type === "skill") return { label: "技能", name: reference.name, icon: WandSparkles };
  if (reference.type === "knowledge") return { label: "知识库", name: reference.name, icon: Database };
  return { label: reference.kind === "directory" ? "目录" : "文件", name: reference.name, icon: reference.kind === "directory" ? Folder : File };
}
