import { useEffect, useId, useRef, useState } from "react";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { Plus, Trash2 } from "lucide-react";
import {
  WORKFLOW_TYPES,
  type WorkflowBinding,
  type WorkflowField,
  type WorkflowInputField,
  type WorkflowFile,
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
  field: WorkflowInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
}) {
  if (field.enumValues?.length)
    return (
      <WorkflowEnumValue
        field={field}
        value={value}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
  if (["image", "video", "audio", "file"].includes(field.type))
    return (
      <WorkflowMediaValue
        field={field}
        value={value}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
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
        min={field.min}
        max={field.max}
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

/** 枚举用索引表达选项，避免数字、布尔值经过 DOM 后丢失真实类型。 */
function WorkflowEnumValue({
  field,
  value,
  onChange,
  onValidity,
}: {
  field: WorkflowInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
}) {
  const options = field.enumValues!;
  const selected = options.findIndex((option) => option === value);
  useEffect(() => {
    onValidity?.(selected >= 0);
  }, [selected, JSON.stringify(options)]);
  useEffect(() => () => onValidity?.(true), []);
  return (
    <>
      <select
        aria-label={field.name}
        aria-invalid={selected < 0}
        value={selected}
        onChange={(event) => onChange(options[Number(event.target.value)])}
      >
        <option value={-1} disabled>
          {value === undefined
            ? "请选择枚举值"
            : "当前值已不在枚举范围内，请重新选择"}
        </option>
        {options.map((option, index) => (
          <option key={index} value={index}>
            {String(option)}
            {options.some(
              (other) => other !== option && String(other) === String(option),
            )
              ? ` · ${typeof option}`
              : ""}
          </option>
        ))}
      </select>
      {selected < 0 && (
        <small className="wf-error">请选择接口允许的枚举值。</small>
      )}
    </>
  );
}

/** 媒体固定值上传到受控资产目录，输入中只保存文件引用。 */
function WorkflowMediaValue({
  field,
  value,
  onChange,
  onValidity,
}: {
  field: WorkflowInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
}) {
  const { runApiTask } = useApiTask();
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entries = (
    Array.isArray(value) ? value : value ? [value] : []
  ) as WorkflowFile[];
  const valid =
    entries.length > 0 &&
    entries.every(
      (item) =>
        item &&
        typeof item.assetId === "string" &&
        typeof item.mediaType === "string" &&
        (field.type === "file" || item.mediaType.startsWith(`${field.type}/`)),
    );
  useEffect(() => {
    onValidity?.(valid && !busy);
  }, [valid, busy]);
  useEffect(() => () => onValidity?.(true), []);
  return (
    <>
      <input
        aria-label={`上传 ${field.name}`}
        type="file"
        multiple={field.multiple}
        disabled={busy}
        accept={field.type === "file" ? undefined : `${field.type}/*`}
        onChange={(event) => {
          const selected = [...(event.target.files ?? [])];
          if (!selected.length) return;
          setBusy(true);
          void runApiTask(
            async () => {
              if (selected.length > (field.maxItems ?? 100))
                throw new Error(
                  `参数 ${field.name} 最多上传 ${field.maxItems ?? 100} 个文件`,
                );
              const files = await Promise.all(
                selected.map((file) => api.uploadWorkflowFile(file)),
              );
              // 上传期间切换来源或节点后不回写；同节点其他修改使用最新回调保留。
              if (mounted.current)
                latest.current(field.multiple ? files : files[0]);
            },
            { operation: `上传工作流参数 ${field.name}` },
          ).finally(() => {
            if (mounted.current) setBusy(false);
          });
        }}
      />
      <small>
        {busy
          ? "正在上传…"
          : valid
            ? entries.map((item) => item.name).join("、")
            : "请选择媒体文件，或改用上游节点输出。"}
      </small>
    </>
  );
}

/** 根据完整字段定义创建固定值，优先使用接口默认值和真实枚举选项。 */
function initialLiteral(field: WorkflowInputField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.enumValues?.length) return field.enumValues[0];
  if (field.multiple) return [];
  if (field.type === "boolean") return false;
  if (field.type === "integer" || field.type === "float") return field.min ?? 0;
  if (
    field.type === "object" ||
    ["image", "video", "audio", "file"].includes(field.type)
  )
    return {};
  return "";
}

/** 引用通过稳定节点 ID 保存；有声明的输入类型只读，自由输入才允许选类型。 */
export function WorkflowBindingEditor({
  label,
  binding,
  nodes,
  nodeId,
  onChange,
  type = "string",
  field,
  onValidity,
}: {
  label: string;
  binding?: WorkflowBinding;
  nodes: WorkflowNode[];
  nodeId: string;
  onChange: (binding: WorkflowBinding | undefined) => void;
  type?: WorkflowField["type"];
  field?: WorkflowInputField;
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
  const effective = field ?? { name: label, type: constantType };
  const selection =
    binding?.kind === "reference"
      ? `${binding.nodeId}:${binding.field}`
      : binding
        ? "literal"
        : "unset";
  const available = nodes.filter(
    (node) => node.id !== nodeId && node.kind !== "output",
  );
  const missing =
    binding?.kind === "reference" &&
    !available.some(
      (node) =>
        node.id === binding.nodeId &&
        node.outputs.some((output) => output.name === binding.field),
    );
  return (
    <section className="wf-binding" aria-label={`${label} 参数配置`}>
      <div className="wf-parameter-heading">
        <strong>{label}</strong>
        {field && (
          <span className="wf-type-badge">
            {field.enumValues?.length ? "枚举 · " : ""}
            {field.type}
            {field.multiple ? "[]" : ""}
          </span>
        )}
      </div>
      {field?.description && <p className="wf-hint">{field.description}</p>}
      <label className="wf-field">
        值来源
        <select
          aria-label={`${label} 值来源`}
          value={selection}
          onChange={(event) => {
            if (event.target.value === "unset") onChange(undefined);
            else if (event.target.value === "literal")
              onChange({ kind: "literal", value: initialLiteral(effective) });
            else {
              const [source, name] = event.target.value.split(":");
              onChange({ kind: "reference", nodeId: source, field: name });
            }
          }}
        >
          <option value="unset">
            {field?.defaultValue !== undefined ? "使用接口默认值" : "不提供"}
          </option>
          <option value="literal">固定值</option>
          {missing && (
            <option value={selection} disabled>
              引用已失效，请重新选择
            </option>
          )}
          {available.map((node) => (
            <optgroup key={node.id} label={node.name}>
              {node.outputs.map((output) => (
                <option key={output.name} value={`${node.id}:${output.name}`}>
                  {node.name} / {output.name} · {output.type}
                  {output.multiple ? "[]" : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      {binding?.kind === "literal" && (
        <>
          {!field && (
            <label className="wf-field">
              数据类型
              <select
                aria-label={`${label} 常量类型`}
                value={constantType}
                onChange={(event) => {
                  const nextType = event.target.value as WorkflowField["type"];
                  setConstantType(nextType);
                  onChange({
                    kind: "literal",
                    value: initialLiteral({ name: label, type: nextType }),
                  });
                }}
              >
                {["string", "float", "integer", "boolean", "object"].map(
                  (t) => (
                    <option key={t}>{t}</option>
                  ),
                )}
              </select>
            </label>
          )}
          <div className="wf-field">
            <span>参数值</span>
            <WorkflowValue
              field={effective}
              value={binding.value}
              onChange={(value) => onChange({ kind: "literal", value })}
              onValidity={onValidity}
            />
          </div>
        </>
      )}
      {binding?.kind === "reference" && field?.enumValues?.length ? (
        <p className="wf-hint">
          上游值按字符串匹配枚举，转换失败将停止并报错。
        </p>
      ) : null}
      {field?.defaultValue !== undefined && !binding && (
        <small className="wf-hint">
          默认值：{JSON.stringify(field.defaultValue)}
        </small>
      )}
    </section>
  );
}
