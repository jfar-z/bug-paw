import { Activity, Boxes, GitFork, Play, RefreshCw, Save, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  AigcChannelSummary,
  AigcInterfaceCapability,
  AigcInterfaceInput,
  AigcInterfaceRecord,
  AigcInterfaceProtocol,
  AigcPublicFileSummary,
  AigcRunInputValue,
  AigcSettingsDocument,
  AigcTaskDocument,
  AigcTaskRecord,
  AigcUploadedAsset,
  AigcWorkflowDetail,
  AigcWorkflowDocument,
  AigcWorkflowInputMapping,
} from "../../shared/aigc-contracts";
import { api, apiV1Url } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { useOnlineStatus } from "../use-online-status";
import { navigateTo, type AppRoute } from "../router";

interface AigcWorkbenchPageProps {
  route: AppRoute;
}

/** AIGC 工作台页面，按二级路由呈现概览、接口、任务与工作流。 */
export function AigcWorkbenchPage({ route }: AigcWorkbenchPageProps) {
  if (route.page === "aigc-interfaces") return <AigcInterfacesPage />;
  if (route.page === "aigc-interface-detail") return <AigcInterfaceDetail interfaceId={route.interfaceId} />;
  if (route.page === "aigc-run") return <AigcRunPage />;
  if (route.page === "aigc-tasks") return <AigcTasksPage />;
  if (route.page === "aigc-task-detail") return <AigcTaskDetail taskId={route.taskId} />;
  if (route.page === "aigc-workflows") return <AigcWorkflowsPage />;
  if (route.page === "aigc-workflow-detail") return <AigcWorkflowDetail workflowId={route.workflowId} />;
  return <AigcOverview />;
}

/** 概览页汇总渠道、接口、工作流与任务状态。 */
function AigcOverview() {
  const { runApiTask } = useApiTask();
  const [channels, setChannels] = useState<AigcSettingsDocument>();
  const [interfaces, setInterfaces] = useState<{ total: number; enabled: number }>();
  const [workflows, setWorkflows] = useState<{ total: number }>();
  const [tasks, setTasks] = useState<{ total: number; running: number; failed: number }>();

  useEffect(() => {
    void runApiTask(async () => {
      const [channelDocument, interfaceDocument, workflowDocument, taskDocument] = await Promise.all([
        api.getAigcChannels(),
        api.getAigcInterfaces(),
        api.getAigcWorkflows(),
        api.getAigcTasks(),
      ]);
      setChannels(channelDocument);
      setInterfaces({ total: interfaceDocument.interfaces.length, enabled: interfaceDocument.interfaces.filter((item) => item.enabled).length });
      setWorkflows({ total: workflowDocument.workflows.length });
      setTasks({
        total: taskDocument.tasks.length,
        running: taskDocument.tasks.filter((task) => task.status === "queued" || task.status === "running").length,
        failed: taskDocument.tasks.filter((task) => task.status === "failed").length,
      });
      return { channelDocument, interfaceDocument, workflowDocument, taskDocument };
    }, { operation: "加载 AIGC 概览" });
  }, [runApiTask]);

  const cards = [
    { label: "渠道", value: channels?.channels?.length ?? "—", detail: `${channels?.channels?.filter((item) => item.enabled).length ?? 0} 个已启用` },
    { label: "接口", value: interfaces?.total ?? "—", detail: `${interfaces?.enabled ?? 0} 个可试运行` },
    { label: "工作流", value: workflows?.total ?? "—", detail: "ComfyUI 编排资产" },
    { label: "任务", value: tasks?.total ?? "—", detail: `${tasks?.running ?? 0} 运行中 · ${tasks?.failed ?? 0} 失败` },
  ];

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>概览</h1><p>AIGC 接口与生成任务的总览；渠道连接在配置中心维护。</p></header>
      <div className="aigc-overview-grid">
        {cards.map((card) => (
          <section key={card.label} className="aigc-overview-card">
            <span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small>
          </section>
        ))}
      </div>
      <section className="configuration-form-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>当前状态</h2></div></div>
        <p className="configuration-help">渠道、接口和工作流可在对应二级目录中管理；任务页可查看每次生成的进度与产物。</p>
      </section>
    </div>
  );
}

/** 创作台入参字段定义。 */
interface AigcRunFieldDefinition {
  name: string;
  label: string;
  type: AigcWorkflowInputMapping["type"];
  required: boolean;
  options?: string[];
  placeholder?: string;
  /** 为 true 时图片或视频输入使用公共 URL 下拉，而不是本地临时上传。 */
  publicUrl?: boolean;
}

/** 创作台：选择已启用接口，按能力或 ComfyUI 映射动态生成入参并提交试运行。 */
function AigcRunPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [workflow, setWorkflow] = useState<AigcWorkflowDetail>();
  const [values, setValues] = useState<Record<string, AigcRunInputValue>>({});
  const [uploads, setUploads] = useState<Record<string, AigcUploadedAsset>>({});
  const [publicFiles, setPublicFiles] = useState<AigcPublicFileSummary[]>([]);
  const [uploading, setUploading] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [createdTask, setCreatedTask] = useState<AigcTaskRecord>();

  const enabledInterfaces = interfaces.filter((item) => item.enabled);
  const selected = enabledInterfaces.find((item) => item.id === selectedId);
  const fields = selected ? runFields(selected, workflow) : [];

  useEffect(() => {
    void runApiTask(async () => {
      const document = await api.getAigcInterfaces();
      setInterfaces(document.interfaces);
      return document;
    }, { operation: "加载可用的 AIGC 接口" }).then((result) => {
      if (result.status !== "success") return;
      const firstEnabled = result.data.interfaces.find((item) => item.enabled);
      if (firstEnabled) setSelectedId(firstEnabled.id);
    });
  }, [runApiTask]);

  useEffect(() => {
    void runApiTask(async () => {
      const document = await api.getAigcPublicFiles();
      setPublicFiles(document.files);
      return document;
    }, { operation: "加载 AIGC 公共文件" });
  }, [runApiTask]);

  useEffect(() => {
    setCreatedTask(undefined);
    setMessage("");
    if (!selected) {
      setWorkflow(undefined);
      setValues({});
      setUploads({});
      return;
    }
    if (selected.protocol !== "comfyui") {
      setWorkflow(undefined);
      setValues(initialGrokOrOpenAiValues(selected));
      setUploads({});
      return;
    }
    const workflowId = (selected.config as { workflowId?: string }).workflowId;
    if (!workflowId) {
      setWorkflow(undefined);
      setValues({});
      setUploads({});
      return;
    }
    void runApiTask(async () => {
      const next = await api.getAigcWorkflow(workflowId);
      setWorkflow(next.workflow);
      setValues(initialComfyUiValues(next.workflow.inputMappings));
      setUploads({});
      return next;
    }, { operation: "加载 ComfyUI 入参", expected: aigcExpected(setMessage) });
  }, [runApiTask, selected?.id]);

  async function uploadFile(field: AigcRunFieldDefinition, file?: File) {
    if (!file) return;
    setMessage("");
    setUploading(field.name);
    const result = await runApiTask(() => api.uploadAigcInput(file), { operation: `上传 ${field.label}`, expected: aigcExpected(setMessage) });
    setUploading(undefined);
    if (result.status !== "success") return;
    setUploads((current) => ({ ...current, [field.name]: result.data.asset }));
    setValues((current) => ({
      ...current,
      [field.name]: {
        assetId: result.data.asset.id,
        name: result.data.asset.name,
        mediaType: result.data.asset.mediaType,
      },
    }));
  }

  async function uploadPublicFile(field: AigcRunFieldDefinition, file?: File) {
    if (!file) return;
    setMessage("");
    setUploading(field.name);
    const result = await runApiTask(() => api.uploadAigcPublicFile(file), { operation: `上传 ${field.label} 公共文件`, expected: aigcExpected(setMessage) });
    setUploading(undefined);
    if (result.status !== "success") return;
    setPublicFiles((current) => [result.data.file, ...current.filter((item) => item.id !== result.data.file.id)]);
    setValues((current) => ({
      ...current,
      [field.name]: {
        url: result.data.file.url,
        name: result.data.file.name,
        mediaType: result.data.file.mediaType,
      },
    }));
  }

  async function submit() {
    if (!selected || !online || submitting) return;
    setMessage("");
    setCreatedTask(undefined);
    const inputs: Record<string, AigcRunInputValue> = {};
    for (const field of fields) {
      const value = coerceRunValue(field, values[field.name]);
      if (field.required && (value === undefined || value === "")) {
        setMessage(`请填写 ${field.label}`);
        return;
      }
      if (value !== undefined && value !== "") inputs[field.name] = value;
    }
    const result = await runApiTask(() => api.runAigcInterface({ interfaceId: selected.id, inputs }), {
      operation: "创建 AIGC 生成任务",
      expected: aigcExpected(setMessage),
    });
    if (result.status !== "success") return;
    setCreatedTask(result.data);
    setMessage("生成任务已创建，可前往任务页查看进度。");
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>创作</h1><p>选择已启用接口，填写生成参数并提交任务。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>生成任务</h2></div></div>
        <label>
          <span>AIGC 接口</span>
          <select aria-label="AIGC 接口" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">请选择已启用接口</option>
            {enabledInterfaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {selected ? <p className="configuration-help">{capabilityLabel(selected.protocol, selected.capability)} · {selected.protocol.toUpperCase()}</p> : <p className="configuration-help">暂无可用接口，请先在“接口”页创建并启用。</p>}
        {selected ? (
          <>
            {fields.map((field) => (
              <AigcRunField
                key={field.name}
                field={field}
                value={values[field.name]}
                uploaded={uploads[field.name]}
                uploading={uploading === field.name}
                publicFiles={publicFiles}
                onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
                onFile={(file) => void uploadFile(field, file)}
                onPublicFile={(file) => void uploadPublicFile(field, file)}
              />
            ))}
            {!fields.length ? <p className="configuration-help">该接口无需额外入参，可直接开始生成。</p> : null}
            <div className="configuration-save-bar">
              <button type="button" className="configuration-primary-action" disabled={!online || submitting || uploading !== undefined} onClick={() => void submit()}>
                <Play size={16} />{submitting ? "正在创建…" : "开始生成"}
              </button>
            </div>
          </>
        ) : null}
      </section>
      {createdTask ? (
        <section className="aigc-overview-card">
          <span>已创建任务</span>
          <strong>{createdTask.status}</strong>
          <small><a href={`/aigc/tasks/${encodeURIComponent(createdTask.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-task-detail", taskId: createdTask.id }); }}>查看任务详情</a></small>
        </section>
      ) : null}
    </div>
  );
}

/** 渲染单个 AIGC 入参字段。 */
function AigcRunField(props: {
  field: AigcRunFieldDefinition;
  value: AigcRunInputValue | undefined;
  uploaded?: AigcUploadedAsset;
  uploading: boolean;
  publicFiles: AigcPublicFileSummary[];
  onChange: (value: AigcRunInputValue) => void;
  onFile: (file?: File) => void;
  onPublicFile: (file?: File) => void;
}) {
  const { field, value, uploaded, uploading, publicFiles, onChange, onFile, onPublicFile } = props;
  if (field.type === "bool") {
    return (
      <label className="configuration-check-line">
        <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
        <span>{field.label}{field.required ? " *" : ""}</span>
      </label>
    );
  }
  if (field.type === "enum") {
    return (
      <label>
        <span>{field.label}{field.required ? " *" : ""}</span>
        <select aria-label={field.label} value={typeof value === "string" ? value : ""} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option>
          {(field.options ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      </label>
    );
  }
  if (field.type === "image" || field.type === "video") {
    const accept = field.type === "video" ? "video/*" : "image/*";
    if (field.publicUrl) {
      const selectedUrl = publicUrlFromValue(value);
      const availableFiles = publicFiles.filter((file) => field.type === "video"
        ? file.mediaType.startsWith("video/")
        : file.mediaType.startsWith("image/"));
      return (
        <div className="configuration-field-row">
          <label>
            <span>{field.label}{field.required ? " *" : ""}</span>
            <select
              aria-label={`${field.label}公共文件`}
              value={selectedUrl}
              onChange={(event) => {
                const selectedFile = availableFiles.find((file) => file.url === event.target.value);
                if (selectedFile) {
                  onChange({ url: selectedFile.url, name: selectedFile.name, mediaType: selectedFile.mediaType });
                }
              }}
            >
              <option value="">请选择公共文件</option>
              {availableFiles.map((file) => <option key={file.id} value={file.url}>{file.name}</option>)}
            </select>
          </label>
          <label>
            <span>上传到公共区</span>
            <input type="file" accept={accept} aria-label={`上传${field.label}到公共区`} onChange={(event) => onPublicFile(event.target.files?.[0])} />
          </label>
          <small className="configuration-help">{uploading ? "上传中…" : selectedUrl || "选择公共文件或上传后自动填充公网地址"}</small>
        </div>
      );
    }
    return (
      <label>
        <span>{field.label}{field.required ? " *" : ""}</span>
        <input type="file" accept={accept} aria-label={field.label} onChange={(event) => onFile(event.target.files?.[0])} />
        <small className="configuration-help">{uploading ? "上传中…" : uploaded?.name ?? "上传后作为生成入参"}</small>
      </label>
    );
  }
  const isNumber = field.type === "int" || field.type === "double";
  const inputValue = typeof value === "number" || typeof value === "string" ? value : "";
  return (
    <label>
      <span>{field.label}{field.required ? " *" : ""}</span>
      <input
        type={isNumber ? "number" : "text"}
        step={field.type === "double" ? "any" : undefined}
        placeholder={field.placeholder}
        aria-label={field.label}
        value={inputValue}
        onChange={(event) => onChange(isNumber ? event.target.valueAsNumber || "" : event.target.value)}
      />
    </label>
  );
}

/** 从公共 URL 类型输入值中读取当前地址。 */
function publicUrlFromValue(value: AigcRunInputValue | undefined): string {
  if (typeof value === "object" && value !== null && "url" in value && typeof value.url === "string") return value.url;
  return "";
}

/** 根据接口协议和工作流映射生成创作台字段。 */
function runFields(item: AigcInterfaceRecord, workflow?: AigcWorkflowDetail): AigcRunFieldDefinition[] {
  if (item.protocol === "comfyui") {
    return (workflow?.inputMappings ?? []).map((mapping) => ({
      name: mapping.name,
      label: mapping.description || mapping.name,
      type: mapping.type,
      required: mapping.required,
      options: mapping.enumOptions,
      placeholder: mapping.description || `输入 ${mapping.name}`,
    }));
  }
  if (item.protocol === "grok") return grokRunFields(item);
  const fields: AigcRunFieldDefinition[] = [{ name: "prompt", label: "提示词", type: "string", required: true, placeholder: "描述要生成的画面或图片" }];
  if (item.capability === "image-edit") {
    fields.push({ name: "image", label: "图片", type: "image", required: true });
  }
  return fields;
}

/** 根据 Grok 能力生成创作台入参字段。 */
function grokRunFields(item: AigcInterfaceRecord): AigcRunFieldDefinition[] {
  const isOptionalPrompt = item.capability === "video-extend";
  const fields: AigcRunFieldDefinition[] = [{
    name: "prompt",
    label: isOptionalPrompt ? "续写提示词（可选）" : "提示词",
    type: "string",
    required: !isOptionalPrompt,
    placeholder: isOptionalPrompt ? "描述视频续写方向" : "描述要生成的画面或视频",
  }];
  if (item.capability === "text-to-image") {
    fields.push({ name: "count", label: "生成数量", type: "int", required: false, placeholder: "1" });
  }
  if (item.capability === "image-edit" || item.capability === "image-to-video") {
    fields.push({ name: "image", label: "图片公网地址", type: "image", required: true, publicUrl: true });
  }
  if (item.capability === "video-edit" || item.capability === "video-extend") {
    fields.push({ name: "video", label: "视频公网地址", type: "video", required: true, publicUrl: true });
  }
  if (["text-to-image", "image-edit", "text-to-video", "image-to-video"].includes(item.capability)) {
    fields.push({ name: "size", label: "输出尺寸", type: "string", required: false, placeholder: "例如 1024x1024" });
  }
  if (["text-to-video", "image-to-video", "video-extend"].includes(item.capability)) {
    fields.push({ name: "duration", label: "时长（秒）", type: "int", required: false, placeholder: "1 到 300" });
  }
  return fields;
}

/** 为 OpenAI 或 Grok 接口生成初始表单值。 */
function initialGrokOrOpenAiValues(item: AigcInterfaceRecord): Record<string, AigcRunInputValue> {
  const values: Record<string, AigcRunInputValue> = { prompt: "" };
  if (item.protocol === "grok" && item.capability === "text-to-image") values.count = 1;
  if (item.protocol === "grok") {
    const config = item.config as { size?: string; duration?: number };
    if (config.size) values.size = config.size;
    if (config.duration !== undefined) values.duration = config.duration;
  }
  return values;
}

/** 为 ComfyUI 工作流映射生成初始值。 */
function initialComfyUiValues(mappings: AigcWorkflowInputMapping[]): Record<string, AigcRunInputValue> {
  const values: Record<string, AigcRunInputValue> = {};
  for (const mapping of mappings) {
    if (mapping.type === "bool") values[mapping.name] = typeof mapping.defaultValue === "boolean" ? mapping.defaultValue : false;
    else if (mapping.type === "int" || mapping.type === "double") values[mapping.name] = typeof mapping.defaultValue === "number" ? mapping.defaultValue : "";
    else if (mapping.type === "enum") values[mapping.name] = typeof mapping.defaultValue === "string" ? mapping.defaultValue : mapping.enumOptions?.[0] ?? "";
    else if (mapping.type === "string") values[mapping.name] = typeof mapping.defaultValue === "string" ? mapping.defaultValue : "";
  }
  return values;
}

/** 将表单值转换为提交给服务端的 AIGC 入参。 */
function coerceRunValue(field: AigcRunFieldDefinition, value: AigcRunInputValue | undefined): AigcRunInputValue | undefined {
  if (value === undefined || value === null) return undefined;
  if (field.type === "bool") return value === true;
  if (field.type === "int" || field.type === "double") {
    if (value === "") return undefined;
    const number = Number(value);
    if (!Number.isFinite(number)) return undefined;
    return field.type === "int" ? Math.trunc(number) : number;
  }
  if (field.type === "string") {
    const text = String(value).trim();
    return text;
  }
  if (field.type === "enum") return typeof value === "string" ? value : undefined;
  if (typeof value === "object" && ("assetId" in value || "url" in value)) return value;
  return undefined;
}

/** 返回接口能力的展示文案。 */
function capabilityLabel(protocol: AigcInterfaceProtocol, capability: AigcInterfaceCapability): string {
  return capabilityOptions(protocol).find((option) => option.value === capability)?.label ?? capability;
}

/** 接口列表与编辑。 */
function AigcInterfacesPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<{ revision: string; interfaces: AigcInterfaceRecord[] }>();
  const [channels, setChannels] = useState<AigcChannelSummary[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState<AigcInterfaceRecord>();
  const [draft, setDraft] = useState<AigcInterfaceInput>(emptyInterface);
  const [message, setMessage] = useState("");

  async function refresh() {
    const [next, channelDocument, workflowDocument] = await Promise.all([
      api.getAigcInterfaces(),
      api.getAigcChannels(),
      api.getAigcWorkflows(),
    ]);
    setDocument(next);
    setChannels(channelDocument.channels);
    setWorkflows(workflowDocument.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name })));
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 AIGC 接口" }).then((result) => {
      if (result.status !== "success") return;
      if (result.data.interfaces[0]) select(result.data.interfaces[0]);
    });
  }, [runApiTask]);

  function select(item: AigcInterfaceRecord) {
    setSelected(item);
    setDraft({
      name: item.name,
      description: item.description,
      protocol: item.protocol,
      capability: item.capability,
      channelId: item.channelId,
      enabled: item.enabled,
      toolPublishEnabled: item.toolPublishEnabled,
      config: item.config as AigcInterfaceInput["config"],
    });
  }

  function createDraft() {
    setSelected(undefined);
    setDraft({ ...emptyInterface, channelId: channels.find((channel) => channel.enabled)?.id ?? "" });
  }

  async function save() {
    if (!online) return;
    setMessage("");
    try {
      const result = selected
        ? await runApiTask(() => api.updateAigcInterface(selected.id, document?.revision ?? "", draft), { operation: "保存 AIGC 接口", expected: aigcExpected(setMessage) })
        : await runApiTask(() => api.createAigcInterface(draft), { operation: "保存 AIGC 接口", expected: aigcExpected(setMessage) });
      if (result.status !== "success") return;
      const next = await refresh();
      const current = next.interfaces.find((item) => item.id === selected?.id) ?? next.interfaces.at(-1);
      if (current) select(current);
      setMessage("已保存 AIGC 接口");
    } catch {
      setMessage("刷新 AIGC 接口失败");
    }
  }

  async function remove() {
    if (!selected || !document || !online) return;
    setMessage("");
    const result = await runApiTask(() => api.deleteAigcInterface(selected.id, document.revision), { operation: "删除 AIGC 接口", expected: aigcExpected(setMessage) });
    if (result.status !== "success") return;
    const next = await refresh();
    setSelected(undefined);
    setDraft(emptyInterface);
    setMessage("已删除 AIGC 接口");
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>接口</h1><p>把渠道、能力与 ComfyUI 工作流组合成可手动试运行的 AIGC 接口。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>接口定义</h2></div><button type="button" onClick={createDraft} disabled={!online}><Boxes size={15} />新增</button></div>
        <div className="configuration-button-row">
          {(document?.interfaces ?? []).map((item) => (
            <button type="button" key={item.id} className={selected?.id === item.id ? "is-selected" : undefined} onClick={() => select(item)}>{item.name}</button>
          ))}
        </div>
        <label><span>接口名称</span><input aria-label="AIGC 接口名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>描述</span><textarea aria-label="AIGC 接口描述" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <div className="configuration-field-row">
          <label><span>协议</span><select aria-label="AIGC 接口协议" value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as AigcInterfaceProtocol, capability: defaultCapability(event.target.value as AigcInterfaceProtocol) })}>
            <option value="openai">OpenAI</option><option value="grok">Grok</option><option value="comfyui">ComfyUI</option>
          </select></label>
          <label><span>能力</span><select aria-label="AIGC 接口能力" value={draft.capability} onChange={(event) => setDraft({ ...draft, capability: event.target.value as AigcInterfaceCapability })}>
            {capabilityOptions(draft.protocol).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select></label>
        </div>
        <label><span>渠道</span><select aria-label="AIGC 渠道" value={draft.channelId} onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}>
          <option value="">请选择渠道</option>
          {channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}（{channel.type}）</option>)}
        </select></label>
        <label><span>{draft.protocol === "comfyui" ? "工作流" : "模型"}</span>
          {draft.protocol === "comfyui" ? (
            <select aria-label="ComfyUI 工作流" value={(draft.config as { workflowId?: string }).workflowId ?? ""} onChange={(event) => setDraft({ ...draft, config: { workflowId: event.target.value } })}>
              <option value="">请选择工作流</option>
              {workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{workflow.name}</option>)}
            </select>
          ) : (
            <input aria-label="AIGC 模型" value={(draft.config as { model?: string }).model ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, model: event.target.value } })} />
          )}
        </label>
        {draft.protocol === "grok" ? (
          <div className="configuration-field-row">
            <label><span>默认尺寸</span><input aria-label="Grok 默认尺寸" placeholder="1024x1024" value={(draft.config as { size?: string }).size ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, size: event.target.value } })} /></label>
            <label><span>默认时长（秒）</span><input type="number" min={1} max={300} aria-label="Grok 默认时长" value={(draft.config as { duration?: number }).duration ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, duration: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : undefined } })} /></label>
          </div>
        ) : null}
        {draft.protocol === "openai" ? (
          <div className="configuration-field-row">
            <label><span>尺寸</span><input aria-label="OpenAI 尺寸" placeholder="1024x1024" value={(draft.config as { size?: string }).size ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, size: event.target.value } })} /></label>
            <label><span>质量</span><input aria-label="OpenAI 质量" placeholder="standard" value={(draft.config as { quality?: string }).quality ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, quality: event.target.value } })} /></label>
          </div>
        ) : null}
        <label className="configuration-check-line"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>启用接口</span></label>
        <label className="configuration-check-line"><input type="checkbox" checked={draft.toolPublishEnabled} onChange={(event) => setDraft({ ...draft, toolPublishEnabled: event.target.checked })} /><span>预留未来发布为 Agent 工具</span></label>
      </section>
      <div className="configuration-save-bar">
        <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!selected || !online} onClick={() => void remove()}><Trash2 size={15} />删除</button>
        <button type="button" className="configuration-primary-action" disabled={!online} onClick={() => void save()}><Save size={16} />保存接口</button>
      </div>
    </div>
  );
}

/** 接口详情页复用编辑表单。 */
function AigcInterfaceDetail({ interfaceId }: { interfaceId: string }) {
  const { runApiTask } = useApiTask();
  const [item, setItem] = useState<AigcInterfaceRecord>();
  const [channels, setChannels] = useState<AigcChannelSummary[]>([]);
  const [workflows, setWorkflows] = useState<{ id: string; name: string }[]>([]);
  const [draft, setDraft] = useState<AigcInterfaceInput>(emptyInterface);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void runApiTask(async () => {
      const [channelsDocument, workflowsDocument] = await Promise.all([api.getAigcChannels(), api.getAigcWorkflows()]);
      const found = (await api.getAigcInterfaces()).interfaces.find((candidate) => candidate.id === interfaceId);
      if (!found) throw new Error("接口不存在");
      setChannels(channelsDocument.channels);
      setWorkflows(workflowsDocument.workflows.map((workflow) => ({ id: workflow.id, name: workflow.name })));
      setItem(found);
      setDraft({
        name: found.name,
        description: found.description,
        protocol: found.protocol,
        capability: found.capability,
        channelId: found.channelId,
        enabled: found.enabled,
        toolPublishEnabled: found.toolPublishEnabled,
        config: found.config as AigcInterfaceInput["config"],
      });
      return found;
    }, { operation: "加载 AIGC 接口详情" });
  }, [interfaceId, runApiTask]);

  async function save() {
    if (!item) return;
    const result = await runApiTask(async () => {
      const document = await api.getAigcInterfaces();
      return api.updateAigcInterface(item.id, document.revision, draft);
    }, { operation: "保存 AIGC 接口", expected: aigcExpected(setMessage) });
    if (result.status === "success") setMessage("已保存 AIGC 接口");
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>接口详情</h1><p>编辑接口的协议、能力与目标工作流。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <label><span>名称</span><input aria-label="AIGC 接口名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>描述</span><textarea aria-label="AIGC 接口描述" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        <p className="configuration-help">协议、渠道与能力已在接口列表中创建；如需变更协议，请删除后重新创建。</p>
        {draft.protocol === "comfyui" ? <p className="configuration-help">工作流：{workflows.find((item) => item.id === (draft.config as { workflowId?: string }).workflowId)?.name ?? "未找到"}</p> : null}
        <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" onClick={() => void save()}><Save size={16} />保存接口</button></div>
      </section>
    </div>
  );
}

/** 任务列表页。 */
function AigcTasksPage() {
  const { runApiTask } = useApiTask();
  const [document, setDocument] = useState<AigcTaskDocument>();
  const [message, setMessage] = useState("");

  async function refresh() {
    const next = await api.getAigcTasks();
    setDocument(next);
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 AIGC 任务" });
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [runApiTask]);

  async function cancel(id: string) {
    const result = await runApiTask(() => api.cancelAigcTask(id), { operation: "取消 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success") await refresh();
  }

  async function retry(id: string) {
    const result = await runApiTask(() => api.retryAigcTask(id), { operation: "重试 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success") await refresh();
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>任务</h1><p>查看生成任务状态、失败原因与产物下载。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <div className="aigc-task-list">
        {(document?.tasks ?? []).map((task) => (
          <section key={task.id} className="aigc-task-row">
            <div><strong>{task.interfaceName}</strong><span>{task.status}</span><small>{task.id}</small></div>
            <p>{task.error ? `${task.error.code}: ${task.error.message}` : `${task.assetCount} 个产物`}</p>
            <div className="aigc-task-actions">
              {(task.status === "queued" || task.status === "running") ? <button type="button" onClick={() => void cancel(task.id)}>取消</button> : null}
              {(task.status === "failed" || task.status === "cancelled") ? <button type="button" onClick={() => void retry(task.id)}><RefreshCw size={14} />重试</button> : null}
              <a href={`/aigc/tasks/${encodeURIComponent(task.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-task-detail", taskId: task.id }); }}>查看</a>
            </div>
          </section>
        ))}
        {!document?.tasks.length ? <p className="configuration-help">暂无 AIGC 任务。</p> : null}
      </div>
    </div>
  );
}

/** 任务详情页。 */
function AigcTaskDetail({ taskId }: { taskId: string }) {
  const { runApiTask } = useApiTask();
  const [task, setTask] = useState<AigcTaskRecord>();
  const [message, setMessage] = useState("");

  useEffect(() => {
    void runApiTask(() => api.getAigcTask(taskId).then((next) => { setTask(next); return next; }), { operation: "加载 AIGC 任务详情" });
    const timer = window.setInterval(() => void api.getAigcTask(taskId).then(setTask).catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [runApiTask, taskId]);

  async function retry() {
    const result = await runApiTask(() => api.retryAigcTask(taskId), { operation: "重试 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success" && result.data) setTask(result.data);
  }

  if (!task) return <div className="aigc-workbench-page"><p className="configuration-help">正在加载任务…</p></div>;
  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>任务详情</h1><p>{task.interfaceName} · {task.status}</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="aigc-task-meta"><span>任务 ID</span><code>{task.id}</code></div>
        <div className="aigc-task-meta"><span>状态</span><strong>{task.status}</strong></div>
        <div className="aigc-task-meta"><span>创建时间</span><time>{new Date(task.createdAt).toLocaleString()}</time></div>
        {task.error ? <p className="configuration-help">错误：{task.error.code} {task.error.message}</p> : null}
        <h2>产物</h2>
        {task.assets.map((asset) => <p key={asset.id}><a href={apiV1Url(`/api/aigc/tasks/${encodeURIComponent(task.id)}/assets/${encodeURIComponent(asset.id)}`)}>{asset.name}</a>（{asset.mediaType}）</p>)}
        {!task.assets.length ? <p className="configuration-help">暂无产物。</p> : null}
        {(task.status === "failed" || task.status === "cancelled") ? <button type="button" className="configuration-secondary-action" onClick={() => void retry()}><RefreshCw size={15} />重试</button> : null}
      </section>
    </div>
  );
}

/** 工作流导入与列表页。 */
function AigcWorkflowsPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<AigcWorkflowDocument>();
  const [name, setName] = useState("");
  const [fileName, setFileName] = useState("");
  const [rawText, setRawText] = useState("");
  const [message, setMessage] = useState("");

  async function refresh() {
    const next = await api.getAigcWorkflows();
    setDocument(next);
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 ComfyUI 工作流" });
  }, [runApiTask]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    setName(file.name.replace(/\.json$/iu, ""));
    setRawText(await file.text());
  }

  async function save() {
    if (!online) return;
    setMessage("");
    let workflowJson: unknown;
    try {
      workflowJson = JSON.parse(rawText);
    } catch {
      setMessage("ComfyUI 工作流 JSON 格式无效");
      return;
    }
    const result = await runApiTask(() => api.createAigcWorkflow({ name, fileName, workflowJson, inputMappings: [], outputMappings: [] }), {
      operation: "导入 ComfyUI 工作流",
      expected: aigcExpected(setMessage),
    });
    if (result.status !== "success") return;
    await refresh();
    setName("");
    setFileName("");
    setRawText("");
    setMessage("已导入 ComfyUI 工作流");
  }

  async function remove(id: string) {
    if (!document) return;
    const result = await runApiTask(() => api.deleteAigcWorkflow(id, document.revision), { operation: "删除 ComfyUI 工作流", expected: aigcExpected(setMessage) });
    if (result.status === "success") await refresh();
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>工作流</h1><p>导入 ComfyUI JSON，解析节点后配置输入与输出映射。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>导入工作流</h2></div></div>
        <label><span>JSON 文件</span><input type="file" accept=".json,application/json" aria-label="ComfyUI 工作流文件" onChange={(event) => void onFile(event.target.files?.[0])} /></label>
        <label><span>工作流名称</span><input aria-label="工作流名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>原始 JSON</span><textarea aria-label="ComfyUI 工作流 JSON" rows={10} spellCheck={false} value={rawText} onChange={(event) => setRawText(event.target.value)} /></label>
        <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" disabled={!online} onClick={() => void save()}><Upload size={15} />导入并解析</button></div>
      </section>
      <div className="aigc-task-list">
        {(document?.workflows ?? []).map((workflow) => (
          <section key={workflow.id} className="aigc-task-row">
            <div><strong>{workflow.name}</strong><span>{workflow.fileName}</span><small>{workflow.nodeCount} 节点 · {workflow.edgeCount} 连线</small></div>
            <p>{workflow.inputCount} 个入参 · {workflow.outputCount} 个输出映射</p>
            <div className="aigc-task-actions"><a href={`/aigc/workflows/${encodeURIComponent(workflow.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-workflow-detail", workflowId: workflow.id }); }}>配置映射</a><button type="button" onClick={() => void remove(workflow.id)}><Trash2 size={14} />删除</button></div>
          </section>
        ))}
        {!document?.workflows.length ? <p className="configuration-help">尚未导入工作流。</p> : null}
      </div>
    </div>
  );
}

/** 工作流详情页，提供节点与映射查看和 JSON 编辑。 */
function AigcWorkflowDetail({ workflowId }: { workflowId: string }) {
  const { runApiTask } = useApiTask();
  const [detail, setDetail] = useState<AigcWorkflowDetail>();
  const [revision, setRevision] = useState("");
  const [name, setName] = useState("");
  const [inputJson, setInputJson] = useState("[]");
  const [outputJson, setOutputJson] = useState("[]");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void runApiTask(async () => {
      const next = await api.getAigcWorkflow(workflowId);
      setDetail(next.workflow);
      setRevision(next.revision);
      setName(next.workflow.name);
      setInputJson(JSON.stringify(next.workflow.inputMappings, null, 2));
      setOutputJson(JSON.stringify(next.workflow.outputMappings, null, 2));
      return next;
    }, { operation: "加载 ComfyUI 工作流详情" });
  }, [runApiTask, workflowId]);

  async function save() {
    let inputMappings;
    let outputMappings;
    try {
      inputMappings = JSON.parse(inputJson);
      outputMappings = JSON.parse(outputJson);
      if (!Array.isArray(inputMappings) || !Array.isArray(outputMappings)) throw new Error();
    } catch {
      setMessage("映射 JSON 格式无效");
      return;
    }
    const result = await runApiTask(() => api.updateAigcWorkflow(workflowId, revision, { name, inputMappings, outputMappings }), {
      operation: "保存 ComfyUI 工作流映射",
      expected: aigcExpected(setMessage),
    });
    if (result.status === "success") {
      setMessage("已保存工作流映射");
      const next = await api.getAigcWorkflow(workflowId);
      setRevision(next.revision);
      setDetail(next.workflow);
    }
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>工作流详情</h1><p>{detail?.fileName ?? workflowId}</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <label><span>名称</span><input aria-label="工作流名称" value={name} onChange={(event) => setName(event.target.value)} /></label>
        <div className="aigc-node-list">
          {(detail?.nodes ?? []).map((node) => <p key={node.id}><strong>{node.type}</strong> · {node.fields.length} 个可映射字段</p>)}
        </div>
        <label><span>入参映射 JSON</span><textarea aria-label="ComfyUI 入参映射" rows={8} spellCheck={false} value={inputJson} onChange={(event) => setInputJson(event.target.value)} /></label>
        <label><span>输出映射 JSON</span><textarea aria-label="ComfyUI 输出映射" rows={5} spellCheck={false} value={outputJson} onChange={(event) => setOutputJson(event.target.value)} /></label>
        <div className="configuration-save-bar"><button type="button" className="configuration-primary-action" onClick={() => void save()}><Save size={15} />保存映射</button></div>
      </section>
    </div>
  );
}

const emptyInterface: AigcInterfaceInput = {
  name: "",
  description: "",
  protocol: "openai",
  capability: "text-to-image",
  channelId: "",
  enabled: true,
  toolPublishEnabled: false,
  config: { model: "" },
};

function defaultCapability(protocol: AigcInterfaceProtocol): AigcInterfaceCapability {
  if (protocol === "grok") return "text-to-video";
  if (protocol === "comfyui") return "text-to-image";
  return "text-to-image";
}

function capabilityOptions(protocol: AigcInterfaceProtocol): Array<{ value: AigcInterfaceCapability; label: string }> {
  if (protocol === "openai") return [{ value: "text-to-image", label: "文生图" }, { value: "image-edit", label: "图片编辑" }];
  if (protocol === "grok") return [
    { value: "text-to-image", label: "文生图" },
    { value: "image-edit", label: "图片编辑" },
    { value: "text-to-video", label: "文生视频" },
    { value: "image-to-video", label: "图生视频" },
    { value: "video-edit", label: "视频编辑" },
    { value: "video-extend", label: "视频续写" },
  ];
  return [{ value: "text-to-image", label: "文生图" }, { value: "image-edit", label: "图片编辑" }, { value: "text-to-video", label: "文生视频" }, { value: "image-to-video", label: "图生视频" }];
}

/** 将可恢复业务错误保留在当前页面。 */
function aigcExpected(setMessage: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setMessage(error.message);
  return {
    VERSION_CONFLICT: show,
    VALIDATION_FAILED: show,
    NOT_FOUND: show,
  };
}
