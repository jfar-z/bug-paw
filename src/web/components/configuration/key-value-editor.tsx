import { Plus, Trash2 } from "lucide-react";

export interface KeyValueRow {
  key: string;
  value: string;
}

interface KeyValueEditorProps {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}

/**
 * 使用可增删的键值行编辑 Headers，避免要求用户直接编辑 JSON。
 */
export function KeyValueEditor({ label, rows, onChange }: KeyValueEditorProps) {
  return (
    <section className="key-value-editor" aria-label={label}>
      <header><strong>{label}</strong><button type="button" onClick={() => onChange([...rows, { key: "", value: "" }])}><Plus size={14} aria-hidden="true" />添加一行</button></header>
      {rows.length === 0 ? <p>没有自定义 Header。</p> : rows.map((row, index) => (
        <div key={index}>
          <input aria-label={`${label} 键 ${index + 1}`} placeholder="Header 名称" value={row.key} onChange={(event) => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, key: event.target.value } : item))} />
          <input aria-label={`${label} 值 ${index + 1}`} placeholder="值" value={row.value} onChange={(event) => onChange(rows.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} />
          <button type="button" aria-label={`删除 ${label} 第 ${index + 1} 行`} onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={14} aria-hidden="true" /></button>
        </div>
      ))}
    </section>
  );
}
