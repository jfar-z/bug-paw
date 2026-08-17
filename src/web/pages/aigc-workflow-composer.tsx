import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type {
  AigcWorkflowDetail,
  AigcWorkflowInputMapping,
  AigcWorkflowInputType,
  AigcWorkflowOutputMapping,
  ComfyUiField,
  ComfyUiNode,
} from "../../shared/aigc-contracts";
import { ConfirmationDialog } from "../components/configuration/confirmation-dialog";

interface AigcWorkflowComposerProps {
  workflow: AigcWorkflowDetail;
  name: string;
  onNameChange: (name: string) => void;
  inputMappings: AigcWorkflowInputMapping[];
  outputMappings: AigcWorkflowOutputMapping[];
  onInputMappingsChange: (mappings: AigcWorkflowInputMapping[]) => void;
  onOutputMappingsChange: (mappings: AigcWorkflowOutputMapping[]) => void;
}

/** ComfyUI 工作流可视化编排器，使用节点与字段点选替代手工 JSON 编辑。 */
export function AigcWorkflowComposer(props: AigcWorkflowComposerProps) {
  const { workflow, name, onNameChange, inputMappings, outputMappings, onInputMappingsChange, onOutputMappingsChange } = props;

  return (
    <div className="aigc-workflow-composer">
      <section className="configuration-form-card aigc-config-section">
        <div className="configuration-section__heading">
          <div><span>01</span><h2>工作流信息</h2></div>
          <small>{workflow.fileName}</small>
        </div>
        <label><span>名称</span><input aria-label="工作流名称" value={name} onChange={(event) => onNameChange(event.target.value)} /></label>
        <div className="aigc-workflow-stats">
          <span>{workflow.nodes.length} 个节点</span>
          <span>{workflow.edges.length} 条连线</span>
          <span>{inputMappings.length} 个入参</span>
          <span>{outputMappings.length} 个输出</span>
        </div>
      </section>

      <InputMappingBuilder
        workflow={workflow}
        mappings={inputMappings}
        onChange={onInputMappingsChange}
      />

      <OutputMappingBuilder
        workflow={workflow}
        mappings={outputMappings}
        onChange={onOutputMappingsChange}
      />
    </div>
  );
}

/** 入参映射编辑区。 */
function InputMappingBuilder(props: {
  workflow: AigcWorkflowDetail;
  mappings: AigcWorkflowInputMapping[];
  onChange: (mappings: AigcWorkflowInputMapping[]) => void;
}) {
  const { workflow, mappings, onChange } = props;
  const [draft, setDraft] = useState<AigcWorkflowInputMapping>();
  const [editingId, setEditingId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AigcWorkflowInputMapping>();
  const selectedNode = workflow.nodes.find((node) => node.id === draft?.nodeId);
  const selectedFields = selectedNode ? inputFields(selectedNode) : [];

  function beginAdd() {
    const firstNode = workflow.nodes.find((node) => inputFields(node).length > 0) ?? workflow.nodes[0];
    const firstField = firstNode ? inputFields(firstNode)[0] : undefined;
    setDraft({
      id: "",
      name: firstField ? parameterNameFromField(firstField) : "",
      nodeId: firstNode?.id ?? "",
      field: firstField?.name ?? "",
      type: firstField?.valueType ?? "string",
      required: true,
      enumOptions: [],
      defaultValue: undefined,
      description: "",
    });
    setEditingId("");
  }

  function beginEdit(mapping: AigcWorkflowInputMapping) {
    setDraft({ ...mapping, enumOptions: [...(mapping.enumOptions ?? [])] });
    setEditingId(mapping.id);
  }

  function selectNode(nodeId: string) {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    const firstField = node ? inputFields(node)[0] : undefined;
    setDraft((current) => current ? {
      ...current,
      nodeId,
      field: firstField?.name ?? "",
      type: firstField?.valueType ?? current.type,
    } : current);
  }

  function selectField(field: ComfyUiField) {
    setDraft((current) => current ? { ...current, field: field.name, type: field.valueType ?? current.type } : current);
  }

  function updateDraft<K extends keyof AigcWorkflowInputMapping>(key: K, value: AigcWorkflowInputMapping[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function commit() {
    if (!draft || !draft.name.trim() || !draft.nodeId || !draft.field) return;
    const normalized = { ...draft, name: draft.name.trim() };
    if (editingId) {
      onChange(mappings.map((mapping) => mapping.id === editingId ? { ...normalized, id: editingId } : mapping));
    } else {
      onChange([...mappings, { ...normalized, id: crypto.randomUUID() }]);
    }
    setDraft(undefined);
    setEditingId("");
  }

  return (
    <section className="configuration-form-card aigc-config-section">
      <div className="configuration-section__heading">
        <div><span>02</span><h2>入参映射</h2></div>
        <button type="button" className="configuration-primary-action" onClick={beginAdd}><Plus size={15} />新增入参</button>
      </div>
      <p className="configuration-help">先点选节点，再点选该节点的输入字段，然后配置暴露给调用方的参数名和类型。</p>

      {mappings.length ? (
        <div className="aigc-mapping-list">
          {mappings.map((mapping) => {
            const node = workflow.nodes.find((item) => item.id === mapping.nodeId);
            return (
              <article key={mapping.id} className="aigc-task-row aigc-mapping-card">
                <div className="aigc-mapping-card__main">
                  <strong>{mapping.name}</strong>
                  <span>{node?.title || node?.type || mapping.nodeId} · {mapping.field}</span>
                  <small>{mapping.type}{mapping.required ? " · 必填" : ""}</small>
                </div>
                <div className="aigc-task-actions">
                  <button type="button" onClick={() => beginEdit(mapping)}><Pencil size={14} />编辑</button>
                  <button type="button" className="is-danger" onClick={() => setDeleteTarget(mapping)}><Trash2 size={14} />删除</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="configuration-help">还没有入参映射。工作流执行时可只使用固定节点值。</p>}

      {draft ? (
        <div className="aigc-overview-card aigc-mapping-editor">
          <div className="configuration-section__heading">
            <strong>{editingId ? "编辑入参" : "新增入参"}</strong>
            <button type="button" className="icon-button" aria-label="关闭入参编辑" onClick={() => { setDraft(undefined); setEditingId(""); }}><X size={15} /></button>
          </div>

          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>选择节点</strong><small>点击节点后，右侧字段会同步更新</small></div>
            <div className="aigc-node-picker">
              {workflow.nodes.map((node) => (
                <button
                  type="button"
                  key={node.id}
                  className={draft.nodeId === node.id ? "is-selected" : undefined}
                  onClick={() => selectNode(node.id)}
                >
                  <strong>{node.title || node.type}</strong>
                  <small>{node.type}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>选择字段</strong><small>只展示可作为工作流入参的输入或组件字段</small></div>
            <div className="aigc-field-picker">
              {selectedFields.map((field) => (
                <button
                  type="button"
                  key={field.name}
                  className={draft.field === field.name ? "is-selected" : undefined}
                  onClick={() => selectField(field)}
                >
                  <strong>{field.name}</strong>
                  <small>{field.valueType ?? field.kind}</small>
                </button>
              ))}
              {!selectedFields.length ? <p className="configuration-help">该节点没有可映射的输入字段。</p> : null}
            </div>
          </div>

          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>参数配置</strong><small>定义工作流入参对外暴露的名称和数据类型</small></div>
            <div className="aigc-form-grid">
              <label><span>参数名</span><input aria-label="入参名称" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
              <label><span>类型</span><select aria-label="入参类型" value={draft.type} onChange={(event) => updateDraft("type", event.target.value as AigcWorkflowInputType)}>
                {inputTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select></label>
              <label><span>默认值</span><input aria-label="入参默认值" value={inputDefaultValue(draft)} onChange={(event) => updateDraft("defaultValue", coerceDefaultValue(draft.type, event.target.value))} /></label>
              <label className="configuration-check-line aigc-check-cell"><input type="checkbox" checked={draft.required} onChange={(event) => updateDraft("required", event.target.checked)} /><span>必填</span></label>
              <label className="aigc-span-2"><span>说明</span><input aria-label="入参说明" value={draft.description ?? ""} onChange={(event) => updateDraft("description", event.target.value)} /></label>
              {draft.type === "enum" ? <label className="aigc-span-2"><span>枚举选项</span><textarea aria-label="枚举选项" rows={3} value={(draft.enumOptions ?? []).join("\n")} onChange={(event) => updateDraft("enumOptions", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></label> : null}
            </div>
          </div>

          <div className="configuration-save-bar">
            <button type="button" className="configuration-secondary-action" onClick={() => { setDraft(undefined); setEditingId(""); }}>取消</button>
            <button type="button" className="configuration-primary-action" onClick={commit}><Check size={15} />{editingId ? "保存修改" : "添加映射"}</button>
          </div>
        </div>
      ) : null}
      {deleteTarget ? <ConfirmationDialog title={`删除入参“${deleteTarget.name}”？`} description="删除后该参数将不再写入 ComfyUI 节点；保存工作流前仍可取消本次编辑。" confirmLabel="删除入参" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => { onChange(mappings.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(undefined); }} /> : null}
    </section>
  );
}

/** 输出映射编辑区。 */
function OutputMappingBuilder(props: {
  workflow: AigcWorkflowDetail;
  mappings: AigcWorkflowOutputMapping[];
  onChange: (mappings: AigcWorkflowOutputMapping[]) => void;
}) {
  const { workflow, mappings, onChange } = props;
  const [draft, setDraft] = useState<AigcWorkflowOutputMapping>();
  const [editingId, setEditingId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AigcWorkflowOutputMapping>();
  const selectedNode = workflow.nodes.find((node) => node.id === draft?.nodeId);
  const selectedFields = selectedNode ? outputFields(selectedNode) : [];

  function beginAdd() {
    const firstNode = workflow.nodes.find((node) => outputFields(node).length > 0) ?? workflow.nodes[0];
    const firstField = firstNode ? outputFields(firstNode)[0] : undefined;
    setDraft({
      id: "",
      name: firstField ? firstField.name : "",
      nodeId: firstNode?.id ?? "",
      field: firstField?.name ?? "",
      mediaType: "image",
      description: "",
    });
    setEditingId("");
  }

  function beginEdit(mapping: AigcWorkflowOutputMapping) {
    setDraft({ ...mapping });
    setEditingId(mapping.id);
  }

  function selectNode(nodeId: string) {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    const firstField = node ? outputFields(node)[0] : undefined;
    setDraft((current) => current ? { ...current, nodeId, field: firstField?.name ?? "" } : current);
  }

  function selectField(field: ComfyUiField) {
    setDraft((current) => current ? { ...current, field: field.name } : current);
  }

  function updateDraft<K extends keyof AigcWorkflowOutputMapping>(key: K, value: AigcWorkflowOutputMapping[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function commit() {
    if (!draft || !draft.name.trim() || !draft.nodeId || !draft.field) return;
    const normalized = { ...draft, name: draft.name.trim() };
    if (editingId) {
      onChange(mappings.map((mapping) => mapping.id === editingId ? { ...normalized, id: editingId } : mapping));
    } else {
      onChange([...mappings, { ...normalized, id: crypto.randomUUID() }]);
    }
    setDraft(undefined);
    setEditingId("");
  }

  return (
    <section className="configuration-form-card aigc-config-section">
      <div className="configuration-section__heading">
        <div><span>03</span><h2>输出映射</h2></div>
        <button type="button" className="configuration-primary-action" onClick={beginAdd}><Plus size={15} />新增输出</button>
      </div>
      <p className="configuration-help">点选负责产出结果的节点与输出字段，并说明它属于图片、视频、音频、JSON 还是文本。</p>

      {mappings.length ? (
        <div className="aigc-mapping-list">
          {mappings.map((mapping) => {
            const node = workflow.nodes.find((item) => item.id === mapping.nodeId);
            return (
              <article key={mapping.id} className="aigc-task-row aigc-mapping-card">
                <div className="aigc-mapping-card__main">
                  <strong>{mapping.name}</strong>
                  <span>{node?.title || node?.type || mapping.nodeId} · {mapping.field}</span>
                  <small>{mapping.mediaType}</small>
                </div>
                <div className="aigc-task-actions">
                  <button type="button" onClick={() => beginEdit(mapping)}><Pencil size={14} />编辑</button>
                  <button type="button" className="is-danger" onClick={() => setDeleteTarget(mapping)}><Trash2 size={14} />删除</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="configuration-help">还没有输出映射。执行后只能查看原始任务状态，不能自动提取产物。</p>}

      {draft ? (
        <div className="aigc-overview-card aigc-mapping-editor">
          <div className="configuration-section__heading">
            <strong>{editingId ? "编辑输出" : "新增输出"}</strong>
            <button type="button" className="icon-button" aria-label="关闭输出编辑" onClick={() => { setDraft(undefined); setEditingId(""); }}><X size={15} /></button>
          </div>

          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>选择节点</strong><small>点击负责输出的节点</small></div>
            <div className="aigc-node-picker">
              {workflow.nodes.map((node) => (
                <button type="button" key={node.id} className={draft.nodeId === node.id ? "is-selected" : undefined} onClick={() => selectNode(node.id)}>
                  <strong>{node.title || node.type}</strong>
                  <small>{node.type}</small>
                </button>
              ))}
            </div>
          </div>

          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>选择输出字段</strong><small>通常选择 outputs.images、outputs.videos 等字段</small></div>
            <div className="aigc-field-picker">
              {selectedFields.map((field) => (
                <button type="button" key={field.name} className={draft.field === field.name ? "is-selected" : undefined} onClick={() => selectField(field)}>
                  <strong>{field.name}</strong>
                  <small>{field.kind}</small>
                </button>
              ))}
              {!selectedFields.length ? <p className="configuration-help">该节点没有可读取的输出字段。</p> : null}
            </div>
          </div>

          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>输出配置</strong><small>定义产物名称和媒体类型</small></div>
            <div className="aigc-form-grid">
              <label><span>显示名称</span><input aria-label="输出名称" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
              <label><span>媒体类型</span><select aria-label="输出媒体类型" value={draft.mediaType} onChange={(event) => updateDraft("mediaType", event.target.value as AigcWorkflowOutputMapping["mediaType"])}>
                {outputMediaTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select></label>
              <label className="aigc-span-2"><span>说明</span><input aria-label="输出说明" value={draft.description ?? ""} onChange={(event) => updateDraft("description", event.target.value)} /></label>
            </div>
          </div>

          <div className="configuration-save-bar">
            <button type="button" className="configuration-secondary-action" onClick={() => { setDraft(undefined); setEditingId(""); }}>取消</button>
            <button type="button" className="configuration-primary-action" onClick={commit}><Check size={15} />{editingId ? "保存修改" : "添加输出"}</button>
          </div>
        </div>
      ) : null}
      {deleteTarget ? <ConfirmationDialog title={`删除输出“${deleteTarget.name}”？`} description="删除后工作台将不再从该节点提取对应产物；保存工作流前仍可取消本次编辑。" confirmLabel="删除输出" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => { onChange(mappings.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(undefined); }} /> : null}
    </section>
  );
}

/** 获取可映射为入参的节点字段。 */
function inputFields(node: ComfyUiNode): ComfyUiField[] {
  return node.fields.filter((field) => field.kind === "input" || field.kind === "widget");
}

/** 获取可读取的节点输出字段。 */
function outputFields(node: ComfyUiNode): ComfyUiField[] {
  return node.fields.filter((field) => field.kind === "output");
}

/** 从字段名生成一个可读的默认参数名。 */
function parameterNameFromField(field: ComfyUiField): string {
  const last = field.name.split(".").at(-1) ?? field.name;
  return last || "value";
}

const inputTypeOptions: Array<{ value: AigcWorkflowInputType; label: string }> = [
  { value: "bool", label: "布尔（bool）" },
  { value: "int", label: "整数（int）" },
  { value: "double", label: "浮点（double）" },
  { value: "string", label: "字符串（string）" },
  { value: "enum", label: "枚举（enum）" },
  { value: "image", label: "图片（image）" },
  { value: "video", label: "视频（video）" },
  { value: "audio", label: "音频（audio）" },
];

const outputMediaTypeOptions: Array<{ value: AigcWorkflowOutputMapping["mediaType"]; label: string }> = [
  { value: "image", label: "图片（image）" },
  { value: "video", label: "视频（video）" },
  { value: "audio", label: "音频（audio）" },
  { value: "json", label: "JSON" },
  { value: "text", label: "文本（text）" },
];

/** 将表单文本转换为对应类型的默认值。 */
function coerceDefaultValue(type: AigcWorkflowInputType, value: string): string | number | boolean | undefined {
  if (!value) return undefined;
  if (type === "bool") return value === "true";
  if (type === "int" || type === "double") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  return value;
}

/** 将默认值稳定显示为可编辑文本。 */
function inputDefaultValue(mapping: AigcWorkflowInputMapping): string {
  if (mapping.defaultValue === undefined) return "";
  if (mapping.defaultValue === true) return "true";
  if (mapping.defaultValue === false) return "false";
  return String(mapping.defaultValue);
}
