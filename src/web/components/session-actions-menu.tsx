import { Archive, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionSummary } from "../api";

interface SessionActionsMenuProps {
  session: SessionSummary;
  disabled?: boolean;
  openRequestId?: number;
  onRename: (name: string) => void | Promise<void>;
  onArchive: () => void | Promise<void>;
  onDelete: (deleteScheduledTasks: boolean) => void | Promise<void>;
}

/**
 * 提供单个会话的轻量操作菜单和危险操作确认。
 */
export function SessionActionsMenu({ session, disabled, openRequestId, onRename, onArchive, onDelete }: SessionActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(session.name || session.firstMessage || "新对话");
  const rootRef = useRef<HTMLDivElement>(null);
  const handledOpenRequestRef = useRef(openRequestId);
  const title = session.name || session.firstMessage || "新对话";

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setRenaming(false);
        setConfirmingDelete(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useEffect(() => {
    if (openRequestId === undefined || openRequestId === handledOpenRequestRef.current) {
      return;
    }
    handledOpenRequestRef.current = openRequestId;
    setOpen(true);
    setRenaming(false);
    setConfirmingDelete(false);
  }, [openRequestId]);

  const submitRename = () => {
    const nextName = name.trim();
    if (!nextName) {
      return;
    }
    void onRename(nextName);
    setRenaming(false);
    setOpen(false);
  };

  return (
    <div className="session-actions" ref={rootRef}>
      <button
        type="button"
        className="session-actions__trigger"
        aria-label={`管理会话：${title}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setRenaming(false);
          setConfirmingDelete(false);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="session-actions__popover" role="menu" onKeyDown={(event) => {
          if (event.key === "Escape") {
            setOpen(false);
          }
        }}>
          {renaming ? (
            <input
              autoFocus
              aria-label="重命名会话"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submitRename();
                }
                if (event.key === "Escape") {
                  setRenaming(false);
                }
              }}
            />
          ) : confirmingDelete ? (
            <div className="session-actions__confirm">
              <p>{session.scheduledTaskCount ? `永久删除此会话及绑定的 ${session.scheduledTaskCount} 个定时任务？` : "永久删除此会话？"}</p>
              <div>
                <button type="button" onClick={() => setConfirmingDelete(false)}>取消</button>
                <button type="button" className="is-danger" onClick={() => { void onDelete(Boolean(session.scheduledTaskCount)); setOpen(false); }}>永久删除</button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => setRenaming(true)}><Pencil size={15} />重命名</button>
              <button type="button" role="menuitem" disabled={disabled} onClick={() => { void onArchive(); setOpen(false); }}><Archive size={15} />归档</button>
              <button type="button" role="menuitem" className="is-danger" disabled={disabled} onClick={() => setConfirmingDelete(true)}><Trash2 size={15} />删除</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
