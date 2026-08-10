interface ConfirmationDialogProps {
  title: string;
  description: string;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * 为高影响操作提供应用内二次确认，避免使用浏览器原生确认框。
 */
export function ConfirmationDialog({ title, description, confirmLabel, busy = false, destructive = true, onCancel, onConfirm }: ConfirmationDialogProps) {
  const titleId = "configuration-confirmation-title";

  return (
    <div className="configuration-dialog-backdrop" role="presentation">
      <section className="configuration-dialog provider-rename-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><div><h2 id={titleId}>{title}</h2><p>{description}</p></div></header>
        <footer>
          <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onCancel}>取消</button>
          <button type="button" className={destructive ? "danger-button" : "configuration-primary-action"} disabled={busy} onClick={onConfirm}>{busy ? "处理中…" : confirmLabel}</button>
        </footer>
      </section>
    </div>
  );
}
