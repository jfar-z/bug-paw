import { useEffect, useId, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  WORKFLOW_TYPES,
  type WorkflowBinding,
  type WorkflowField,
  type WorkflowNode,
} from "../../../shared/workflow-contracts";

/** JSON 编辑保留未完成文本，同时将校验结果反馈给保存按钮。 */
export function WorkflowJson({
  value,
  onChange,
  onValidity,
  label = "JSON",
  objectOnly = false,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
  label?: string;
  objectOnly?: boolean;
}) {
  const serialized = JSON.stringify(value ?? {}, null, 2),
    [text, setText] = useState(serialized),
    [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    // 同一次有效键入不重排文本或跳走光标；外部值变化时才同步编辑器。
    try {
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(value ?? {}))
        return;
    } catch {
      // 尚未完成的 JSON 在外部值变化时重置。
    }
    setText(serialized);
    setError("");
  }, [serialized]);
  useEffect(() => () => onValidity?.(true), []);
  return (
    <label className="wf-field">
      {label}
      <textarea
        aria-label={label}
        className="wf-code"
        value={text}
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={error ? id : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            if (
              objectOnly &&
              (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            )
              throw new Error("需要 JSON 对象");
            setError("");
            onValidity?.(true);
            onChange(parsed);
          } catch {
            setError(
              objectOnly ? "请输入有效 JSON 对象。" : "请输入有效 JSON。",
            );
            onValidity?.(false);
          }
        }}
      />
      {error && (
        <small id={id} className="wf-error">
          {error}
        </small>
      )}
    </label>
  );
}

/** 常量控件按声明类型保留 false、0 和空字符串；不通过字符串猜测类型。 */
export function WorkflowValue({
  field,
  value,
  onChange,
  onValidity,
}: {
  field: WorkflowField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
}) {
  if (field.multiple || field.type === "object")
    return (
      <WorkflowJson
        label={field.description || field.name}
        value={value ?? (field.multiple ? [] : {})}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
  if (field.type === "boolean")
    return (
      <label className="wf-check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {field.description || field.name}
      </label>
    );
  if (field.type === "integer" || field.type === "float")
    return (
      <input
        aria-label={field.name}
        type="number"
        value={value === undefined || value === null ? "" : String(value)}
        step={field.type === "integer" ? 1 : "any"}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  return (
    <textarea
      aria-label={field.name}
      rows={3}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 参数定义供输入、输出及脚本共用；输出不设置默认值以免掩盖执行遗漏。 */
export function WorkflowFieldList({
  fields,
  onChange,
  defaults = false,
}: {
  fields: WorkflowField[];
  onChange: (fields: WorkflowField[]) => void;
  defaults?: boolean;
}) {
  const update = (index: number, patch: Partial<WorkflowField>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  return (
    <div className="wf-fields">
      {fields.map((field, index) => (
        <section key={index} className="wf-field-item">
          <div className="wf-row">
            <input
              aria-label={`参数 ${index + 1} 名称`}
              placeholder="参数名，如 prompt"
              value={field.name}
              onChange={(e) => update(index, { name: e.target.value })}
            />
            <button
              type="button"
              className="icon-button"
              aria-label={`删除参数 ${field.name}`}
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              <Trash2 size={15} />
            </button>
          </div>
          <select
            aria-label={`${field.name} 类型`}
            value={field.type}
            onChange={(e) =>
              update(index, {
                type: e.target.value as WorkflowField["type"],
                defaultValue: undefined,
              })
            }
          >
            {WORKFLOW_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <div className="wf-row">
            <label className="wf-check">
              <input
                type="checkbox"
                checked={!!field.multiple}
                onChange={(e) =>
                  update(index, {
                    multiple: e.target.checked,
                    defaultValue: undefined,
                  })
                }
              />
              数组
            </label>
            <label className="wf-check">
              <input
                type="checkbox"
                checked={!!field.required}
                onChange={(e) => update(index, { required: e.target.checked })}
              />
              必填
            </label>
          </div>
          <input
            aria-label={`${field.name} 说明`}
            placeholder="参数说明"
            value={field.description ?? ""}
            onChange={(e) => update(index, { description: e.target.value })}
          />
          {defaults &&
            ["string", "integer", "float", "boolean"].includes(field.type) &&
            !field.multiple && (
              <label className="wf-field">
                默认值
                {field.type === "boolean" ? (
                  <select
                    value={
                      field.defaultValue === undefined
                        ? "unset"
                        : String(field.defaultValue)
                    }
                    onChange={(e) =>
                      update(index, {
                        defaultValue:
                          e.target.value === "unset"
                            ? undefined
                            : e.target.value === "true",
                      })
                    }
                  >
                    <option value="unset">不设置</option>
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    type={field.type === "string" ? "text" : "number"}
                    value={
                      field.defaultValue === undefined
                        ? ""
                        : String(field.defaultValue)
                    }
                    placeholder="不设置"
                    onChange={(e) =>
                      update(index, {
                        defaultValue:
                          e.target.value === ""
                            ? undefined
                            : field.type === "string"
                              ? e.target.value
                              : Number(e.target.value),
                      })
                    }
                  />
                )}
              </label>
            )}
        </section>
      ))}
      <button
        type="button"
        className="wf-button"
        onClick={() =>
          onChange([
            ...fields,
            { name: `param_${fields.length + 1}`, type: "string" },
          ])
        }
      >
        <Plus size={15} />
        添加参数
      </button>
    </div>
  );
}

/** 引用通过稳定节点 ID 和输出名称保存，界面只展示可读标题。 */
export function WorkflowBindingEditor({
  label,
  binding,
  nodes,
  nodeId,
  onChange,
  type = "string",
  onValidity,
}: {
  label: string;
  binding?: WorkflowBinding;
  nodes: WorkflowNode[];
  nodeId: string;
  onChange: (binding: WorkflowBinding | undefined) => void;
  type?: WorkflowField["type"];
  onValidity?: (valid: boolean) => void;
}) {
  const [constantType, setConstantType] = useState<WorkflowField["type"]>(() =>
    binding?.kind === "literal"
      ? typeof binding.value === "boolean"
        ? "boolean"
        : typeof binding.value === "number"
          ? "float"
          : typeof binding.value === "object"
            ? "object"
            : type
      : type,
  );
  const selection =
    binding?.kind === "reference"
      ? `${binding.nodeId}:${binding.field}`
      : binding
        ? "literal"
        : "unset";
  return (
    <section className="wf-binding">
      <label className="wf-field">
        {label}
        <select
          aria-label={label}
          value={selection}
          onChange={(e) => {
            if (e.target.value === "unset") onChange(undefined);
            else if (e.target.value === "literal")
              onChange({
                kind: "literal",
                value:
                  constantType === "boolean"
                    ? false
                    : constantType === "integer" || constantType === "float"
                      ? 0
                      : constantType === "object"
                        ? {}
                        : "",
              });
            else {
              const [source, field] = e.target.value.split(":");
              onChange({ kind: "reference", nodeId: source, field });
            }
          }}
        >
          <option value="unset">不提供</option>
          <option value="literal">固定值</option>
          {nodes
            .filter((n) => n.id !== nodeId && n.kind !== "output")
            .map((n) => (
              <optgroup key={n.id} label={n.name}>
                {n.outputs.map((f) => (
                  <option key={f.name} value={`${n.id}:${f.name}`}>
                    {n.name} / {f.name} · {f.type}
                    {f.multiple ? "[]" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
        </select>
      </label>
      {binding?.kind === "literal" && (
        <>
          <select
            aria-label={`${label} 常量类型`}
            value={constantType}
            onChange={(e) => {
              const t = e.target.value as WorkflowField["type"];
              setConstantType(t);
              onChange({
                kind: "literal",
                value:
                  t === "boolean"
                    ? false
                    : t === "integer" || t === "float"
                      ? 0
                      : t === "object"
                        ? {}
                        : "",
              });
            }}
          >
            {["string", "float", "integer", "boolean", "object"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <WorkflowValue
            field={{ name: label, type: constantType }}
            value={binding.value}
            onChange={(value) => onChange({ kind: "literal", value })}
            onValidity={onValidity}
          />
        </>
      )}
    </section>
  );
}
