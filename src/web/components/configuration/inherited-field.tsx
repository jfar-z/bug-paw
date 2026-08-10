import { cloneElement, type ReactElement, type ReactNode } from "react";

interface InheritedFieldProps {
  label: string;
  inherited: boolean;
  inheritedValue: string;
  onInheritedChange: (inherited: boolean) => void;
  children: ReactElement<{ disabled?: boolean }>;
  help?: ReactNode;
}

/**
 * 统一呈现“继承全局值”与“Agent 局部覆盖”的配置语义。
 */
export function InheritedField({
  label,
  inherited,
  inheritedValue,
  onInheritedChange,
  children,
  help,
}: InheritedFieldProps) {
  return (
    <fieldset className="inherited-field">
      <legend>{label}</legend>
      <label className="inherited-field__switch">
        <input
          type="checkbox"
          checked={inherited}
          onChange={(event) => onInheritedChange(event.target.checked)}
        />
        使用全局默认值
      </label>
      <p>当前继承：{inheritedValue}</p>
      {cloneElement(children, { disabled: inherited || children.props.disabled })}
      {help ? <small>{help}</small> : null}
    </fieldset>
  );
}
