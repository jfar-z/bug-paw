import { Moon, PawPrint, Sun, type LucideIcon } from "lucide-react";
import type { ThemePreference } from "../theme";

interface ThemeSwitcherProps {
  value: ThemePreference;
  onChange: (value: ThemePreference) => void;
  compact?: boolean;
}

const options: Array<{
  value: ThemePreference;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "light", label: "浅色", icon: Sun },
  { value: "dark", label: "深色", icon: Moon },
  { value: "bug", label: "BUG", icon: PawPrint },
];

/**
 * 提供明确可见且可键盘操作的主题选择器。
 */
export function ThemeSwitcher({ value, onChange, compact = false }: ThemeSwitcherProps) {
  if (compact) {
    const currentIndex = options.findIndex((option) => option.value === value);
    const next = options[(currentIndex + 1) % options.length];
    const CurrentIcon = options[currentIndex].icon;

    return (
      <button
        type="button"
        className="icon-button"
        aria-label={`当前主题：${options[currentIndex].label}，切换为${next.label}`}
        title={`当前：${options[currentIndex].label}`}
        onClick={() => onChange(next.value)}
      >
        <CurrentIcon aria-hidden="true" size={18} strokeWidth={1.8} />
      </button>
    );
  }

  return (
    <div className="theme-segment" aria-label="主题设置">
      {options.map((option) => {
        const Icon = option.icon;
        return (
          <button
            type="button"
            key={option.value}
            className={value === option.value ? "is-active" : undefined}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            <Icon aria-hidden="true" size={16} strokeWidth={1.8} />
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
