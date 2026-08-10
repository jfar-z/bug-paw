import type { ReactNode } from "react";

interface SettingsSectionProps {
  index: number;
  title: string;
  description: string;
  children: ReactNode;
}

/**
 * 统一 Pi 设置七个语义分组的标题与表单结构。
 */
export function SettingsSection({ index, title, description, children }: SettingsSectionProps) {
  return <section className="configuration-form-card settings-section"><div className="configuration-section__heading"><div><span>{String(index).padStart(2, "0")}</span><h2>{title}</h2></div><small>{description}</small></div><div>{children}</div></section>;
}
