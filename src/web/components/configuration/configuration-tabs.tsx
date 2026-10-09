/** 配置页分区复用键盘导航，页签切换不会产生保存或丢弃草稿。 */
export function ConfigurationTabs<T extends string>({ value, onChange, items }: { value: T; onChange: (value: T) => void; items: Array<{ value: T; label: string }> }) {
  const panelId = "configuration-maintenance-panel";
  return <div className="configuration-tabs" role="tablist" aria-label="配置页面分区">{items.map((item, index) => <button key={item.value} id={`${panelId}-${item.value}`} aria-controls={panelId} type="button" role="tab" aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} onClick={() => onChange(item.value)} onKeyDown={(event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
    onChange(items[next].value);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }}>{item.label}</button>)}</div>;
}
