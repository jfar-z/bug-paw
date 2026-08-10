import { ArchiveRestore, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { SessionSummary } from "../api";

interface ArchivedSessionsDialogProps {
  open: boolean;
  sessions: SessionSummary[];
  onClose: () => void;
  onOpen: (sessionId: string) => void | Promise<void>;
  onRestore: (sessionId: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
}

/**
 * 集中展示归档会话，并提供恢复和永久删除入口。
 */
export function ArchivedSessionsDialog({ open, sessions, onClose, onOpen, onRestore, onDelete }: ArchivedSessionsDialogProps) {
  const [confirmingId, setConfirmingId] = useState<string>();
  if (!open) {
    return null;
  }

  return (
    <div className="archive-dialog__backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title">
        <header>
          <div><span>会话管理</span><h2 id="archive-dialog-title">已归档会话</h2></div>
          <button type="button" className="icon-button" aria-label="关闭已归档会话" onClick={onClose}><X size={18} /></button>
        </header>
        <div className="archive-dialog__list">
          {sessions.length === 0 && <p className="archive-dialog__empty">还没有归档会话。</p>}
          {sessions.map((session) => {
            const title = session.name || session.firstMessage || "新对话";
            return (
              <article className="archive-dialog__row" key={session.id}>
                <button type="button" className="archive-dialog__open" aria-label={`打开${title}`} onClick={() => void onOpen(session.id)}>
                  <strong>{title}</strong>
                  <span>{session.messageCount} 条消息</span>
                </button>
                {confirmingId === session.id ? (
                  <div className="archive-dialog__confirm">
                    <button type="button" onClick={() => setConfirmingId(undefined)}>取消</button>
                    <button type="button" className="is-danger" onClick={() => { void onDelete(session.id); setConfirmingId(undefined); }}>确认永久删除</button>
                  </div>
                ) : (
                  <div className="archive-dialog__actions">
                    <button type="button" aria-label={`恢复${title}`} onClick={() => void onRestore(session.id)}><ArchiveRestore size={16} /></button>
                    <button type="button" className="is-danger" aria-label={`删除${title}`} onClick={() => setConfirmingId(session.id)}><Trash2 size={16} /></button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
