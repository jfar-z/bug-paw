import { Activity, AlertTriangle, Boxes, CheckCircle2, Download, GitFork, Play, RefreshCw, Save, TestTube2, Trash2, Upload, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  AigcTaskAsset,
  AigcTaskRecord,
  AigcTaskStatus,
  AigcUploadedAsset,
  AigcWorkflowDetail,
  AigcWorkflowDocument,
  AigcWorkflowInputMapping,
  AigcWorkflowOutputMapping,
  AigcWorkflowSummary,
} from "../../shared/aigc-contracts";
import { aigcTaskAssetUrl, api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { ConfirmationDialog } from "../components/configuration/confirmation-dialog";
import { useOnlineStatus } from "../use-online-status";
import { navigateTo, NAVIGATION_BEFORE_EVENT, type AppRoute } from "../router";
import { AigcWorkflowComposer } from "./aigc-workflow-composer";
import "../configuration.css";
import "../aigc.css";

interface AigcWorkbenchPageProps {
  route: AppRoute;
}

/** AIGC 工作台页面，按二级路由呈现概览、接口、任务与工作流。 */
export function AigcWorkbenchPage({ route }: AigcWorkbenchPageProps) {
  if (route.page === "aigc-interfaces") return <AigcInterfacesPage />;
  if (route.page === "aigc-interface-detail") return <AigcInterfaceDetail interfaceId={route.interfaceId} />;
  if (route.page === "aigc-run") return <AigcRunPage preferredInterfaceId={route.interfaceId} />;
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
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [workflows, setWorkflows] = useState<AigcWorkflowDocument>();
  const [tasks, setTasks] = useState<{ total: number; running: number; failed: number }>();
  const [connectionResult, setConnectionResult] = useState<{ channelId: string; ok: boolean; message: string }>();
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void runApiTask(async () => {
      const [channelDocument, interfaceDocument, workflowDocument, taskDocument] = await Promise.all([
        api.getAigcChannels(),
        api.getAigcInterfaces(),
        api.getAigcWorkflows(),
        api.getAigcTasks(),
      ]);
      setChannels(channelDocument);
      setInterfaces(interfaceDocument.interfaces);
      setWorkflows(workflowDocument);
      setTasks({
        total: taskDocument.tasks.length,
        running: taskDocument.tasks.filter((task) => task.status === "queued" || task.status === "running").length,
        failed: taskDocument.tasks.filter((task) => task.status === "failed").length,
      });
      return { channelDocument, interfaceDocument, workflowDocument, taskDocument };
    }, { operation: "加载 AIGC 概览" });
  }, [runApiTask]);

  const enabledComfyChannels = (channels?.channels ?? []).filter((item) => item.type === "comfyui" && item.enabled);
  const runnableComfyInterfaces = interfaces.filter((item) => {
    if (item.protocol !== "comfyui" || !item.enabled) return false;
    const workflowId = (item.config as { workflowId?: string }).workflowId;
    return enabledComfyChannels.some((channel) => channel.id === item.channelId)
      && (workflows?.workflows ?? []).some((workflow) => workflow.id === workflowId);
  });
  const primaryComfyChannel = enabledComfyChannels.find((channel) => channel.id === runnableComfyInterfaces[0]?.channelId) ?? enabledComfyChannels[0];

  async function testComfyUi() {
    if (!primaryComfyChannel || testing) return;
    setTesting(true);
    const result = await runApiTask(() => api.testAigcChannel(primaryComfyChannel.id), { operation: "测试 ComfyUI 连接" });
    setTesting(false);
    if (result.status === "success") setConnectionResult({ channelId: primaryComfyChannel.id, ...result.data });
  }

  const cards = [
    { label: "渠道", value: channels?.channels?.length ?? "—", detail: `${channels?.channels?.filter((item) => item.enabled).length ?? 0} 个已启用` },
    { label: "接口", value: interfaces.length || "—", detail: `${interfaces.filter((item) => item.enabled).length} 个可试运行` },
    { label: "工作流", value: workflows?.workflows.length ?? "—", detail: "ComfyUI 编排资产" },
    { label: "任务", value: tasks?.total ?? "—", detail: `${tasks?.running ?? 0} 运行中 · ${tasks?.failed ?? 0} 失败` },
  ];

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>概览</h1><p>从这里确认创作链路是否就绪，并快速进入 OpenAI、Grok 或 ComfyUI 运行。</p></header>
      <div className="aigc-overview-grid">
        {cards.map((card) => (
          <section key={card.label} className="aigc-overview-card">
            <span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small>
          </section>
        ))}
      </div>
      <section className="configuration-form-card aigc-readiness-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>ComfyUI 运行就绪检查</h2></div><small>{runnableComfyInterfaces.length ? `${runnableComfyInterfaces.length} 个接口可运行` : "尚未就绪"}</small></div>
        <div className="aigc-readiness-list">
          <ReadinessItem ok={enabledComfyChannels.length > 0} label="已启用 ComfyUI 渠道" detail={enabledComfyChannels.length ? enabledComfyChannels.map((item) => item.name).join("、") : "请先创建并启用渠道"} />
          <ReadinessItem ok={(workflows?.workflows.length ?? 0) > 0} label="已导入工作流" detail={workflows?.workflows.length ? `${workflows.workflows.length} 个工作流可配置` : "请导入 ComfyUI API 工作流 JSON"} />
          <ReadinessItem ok={runnableComfyInterfaces.length > 0} label="已创建运行接口" detail={runnableComfyInterfaces.length ? runnableComfyInterfaces.map((item) => item.name).join("、") : "接口需同时引用已启用渠道和现有工作流"} />
          <ReadinessItem
            ok={connectionResult?.ok === true}
            pending={!connectionResult || connectionResult.channelId !== primaryComfyChannel?.id}
            label="实时连接测试"
            detail={connectionResult && connectionResult.channelId === primaryComfyChannel?.id ? connectionResult.message : "尚未检测，不会仅凭配置宣称可用"}
          />
        </div>
        <div className="aigc-readiness-actions">
          {primaryComfyChannel ? <button type="button" className="configuration-secondary-action" disabled={testing} onClick={() => void testComfyUi()}><TestTube2 size={15} />{testing ? "检测中…" : "测试 ComfyUI 连接"}</button> : <button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-channels" })}>配置 ComfyUI 渠道</button>}
          {!workflows?.workflows.length ? <button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-workflows" })}>导入工作流</button> : null}
          {!runnableComfyInterfaces.length ? <button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-interfaces" })}>创建运行接口</button> : null}
          {runnableComfyInterfaces[0] ? <button type="button" className="configuration-primary-action" onClick={() => navigateTo({ page: "aigc-run", interfaceId: runnableComfyInterfaces[0].id })}><Play size={15} />运行 ComfyUI</button> : null}
        </div>
      </section>
    </div>
  );
}

/** 展示一项可操作的运行前置检查。 */
function ReadinessItem({ ok, pending = false, label, detail }: { ok: boolean; pending?: boolean; label: string; detail: string }) {
  return (
    <div className={ok ? "aigc-readiness-item is-ready" : pending ? "aigc-readiness-item is-pending" : "aigc-readiness-item is-missing"}>
      {ok ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
      <span><strong>{label}</strong><small>{detail}</small></span>
    </div>
  );
}

/** 在 AIGC 编辑表单仍有改动时阻止站内导航与浏览器关闭。 */
function useAigcUnsavedNavigation(isDirty: boolean) {
  const [pendingRoute, setPendingRoute] = useState<AppRoute>();
  const allowNavigation = useRef(false);

  useEffect(() => {
    if (!isDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    const preventNavigation = (event: Event) => {
      if (allowNavigation.current) return;
      event.preventDefault();
      setPendingRoute((event as CustomEvent<AppRoute>).detail);
    };
    window.addEventListener("beforeunload", preventUnload);
    window.addEventListener(NAVIGATION_BEFORE_EVENT, preventNavigation);
    return () => {
      window.removeEventListener("beforeunload", preventUnload);
      window.removeEventListener(NAVIGATION_BEFORE_EVENT, preventNavigation);
    };
  }, [isDirty]);

  return {
    pendingRoute,
    cancel: () => setPendingRoute(undefined),
    confirm: () => {
      if (!pendingRoute) return;
      allowNavigation.current = true;
      const route = pendingRoute;
      setPendingRoute(undefined);
      navigateTo(route);
      window.queueMicrotask(() => { allowNavigation.current = false; });
    },
  };
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
function AigcRunPage({ preferredInterfaceId }: { preferredInterfaceId?: string }) {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [channels, setChannels] = useState<AigcChannelSummary[]>([]);
  const [provider, setProvider] = useState<AigcInterfaceProtocol>("openai");
  const [selectedId, setSelectedId] = useState("");
  const [workflow, setWorkflow] = useState<AigcWorkflowDetail>();
  const [values, setValues] = useState<Record<string, AigcRunInputValue>>({});
  const [uploads, setUploads] = useState<Record<string, AigcUploadedAsset>>({});
  const [publicFiles, setPublicFiles] = useState<AigcPublicFileSummary[]>([]);
  const [uploading, setUploading] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [createdTask, setCreatedTask] = useState<AigcTaskRecord>();
  const [connectionResult, setConnectionResult] = useState<{ ok: boolean; message: string }>();
  const [testingConnection, setTestingConnection] = useState(false);

  const enabledInterfaces = interfaces.filter((item) => item.enabled);
  const providerInterfaces = enabledInterfaces.filter((item) => item.protocol === provider);
  const selected = enabledInterfaces.find((item) => item.id === selectedId);
  const fields = selected ? runFields(selected, workflow) : [];
  const selectedChannelReady = Boolean(selected && channels.some((channel) => channel.id === selected.channelId && channel.enabled));
  const selectedReady = Boolean(selected && selectedChannelReady && (selected.protocol !== "comfyui" || workflow));

  useEffect(() => {
    void runApiTask(async () => {
      const [document, channelDocument] = await Promise.all([api.getAigcInterfaces(), api.getAigcChannels()]);
      setInterfaces(document.interfaces);
      setChannels(channelDocument.channels);
      return document;
    }, { operation: "加载可用的 AIGC 接口" }).then((result) => {
      if (result.status !== "success") return;
      const preferred = result.data.interfaces.find((item) => item.enabled && item.id === preferredInterfaceId);
      const firstEnabled = preferred ?? result.data.interfaces.find((item) => item.enabled);
      if (firstEnabled) setProvider(firstEnabled.protocol);
      if (firstEnabled) setSelectedId(firstEnabled.id);
    });
  }, [preferredInterfaceId, runApiTask]);

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
    setConnectionResult(undefined);
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

  function changeProvider(nextProvider: AigcInterfaceProtocol) {
    setProvider(nextProvider);
    setSelectedId(enabledInterfaces.find((item) => item.protocol === nextProvider)?.id ?? "");
  }

  async function testSelectedConnection() {
    if (!selected || testingConnection) return;
    setTestingConnection(true);
    const result = await runApiTask(() => api.testAigcChannel(selected.channelId), { operation: `测试 ${interfaceProtocolName(selected.protocol)} 连接`, expected: aigcExpected(setMessage) });
    setTestingConnection(false);
    if (result.status === "success") setConnectionResult(result.data);
  }

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
    if (!selectedReady) {
      setMessage("当前接口的渠道或工作流尚未就绪，请先修复运行检查项。");
      return;
    }
    setSubmitting(true);
    const result = await runApiTask(() => api.runAigcInterface({ interfaceId: selected.id, inputs }), {
      operation: "创建 AIGC 生成任务",
      expected: aigcExpected(setMessage),
    });
    setSubmitting(false);
    if (result.status !== "success") return;
    setCreatedTask(result.data);
    setMessage("生成任务已创建，可前往任务页查看进度。");
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>创作与运行</h1><p>在同一页面调用 OpenAI、Grok 和 ComfyUI；选择服务后填写参数并查看任务进度。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <div className="aigc-protocol-grid aigc-protocol-grid--compact aigc-provider-switcher" role="tablist" aria-label="生成服务">
        {(["openai", "grok", "comfyui"] as const).map((item) => (
          <button key={item} type="button" role="tab" aria-selected={provider === item} className={provider === item ? "aigc-overview-card aigc-protocol-card is-selected" : "aigc-overview-card aigc-protocol-card"} onClick={() => changeProvider(item)}>
            <strong>{interfaceProtocolName(item)}</strong><small>{interfaceProtocolDescription(item)}</small><span className="aigc-provider-switcher__status">{provider === item ? "当前服务" : `${enabledInterfaces.filter((candidate) => candidate.protocol === item).length} 个接口`}</span>
          </button>
        ))}
      </div>
      <section className="configuration-form-card">
        <div className="configuration-section__heading"><div><span>01</span><h2>生成任务</h2></div></div>
        <label>
          <span>AIGC 接口</span>
          <select aria-label="AIGC 接口" value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">请选择已启用接口</option>
            {providerInterfaces.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {selected ? <p className="configuration-help">{capabilityLabel(selected.protocol, selected.capability)} · {interfaceProtocolName(selected.protocol)}</p> : <div className="aigc-empty-action"><p className="configuration-help">暂无已启用的 {interfaceProtocolName(provider)} 接口。</p><button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "aigc-interfaces" })}>创建 {interfaceProtocolName(provider)} 接口</button></div>}
        {selected && !selectedChannelReady ? <p className="configuration-help aigc-warning-copy">引用的渠道不存在或未启用，请先修复接口配置。</p> : null}
        {selected?.protocol === "comfyui" ? (
          <div className="aigc-run-readiness">
            <ReadinessItem ok={channels.some((channel) => channel.id === selected.channelId && channel.enabled)} label="执行渠道" detail={channels.find((channel) => channel.id === selected.channelId)?.name ?? "引用的渠道不存在"} />
            <ReadinessItem ok={Boolean(workflow)} label="工作流" detail={workflow?.name ?? "引用的工作流不存在或尚未加载"} />
            <ReadinessItem ok={connectionResult?.ok === true} pending={!connectionResult} label="实时连接" detail={connectionResult?.message ?? "提交前建议先检测 ComfyUI 服务"} />
            <button type="button" className="configuration-secondary-action" disabled={testingConnection} onClick={() => void testSelectedConnection()}><TestTube2 size={15} />{testingConnection ? "检测中…" : "测试连接"}</button>
          </div>
        ) : null}
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
              <button type="button" className="configuration-primary-action" disabled={!online || !selectedReady || submitting || uploading !== undefined} onClick={() => void submit()}>
                <Play size={16} />{submitting ? "正在创建…" : "开始生成"}
              </button>
            </div>
          </>
        ) : null}
      </section>
      {createdTask ? (
        <section className="aigc-overview-card">
          <span>已创建任务</span>
          <strong>{taskStatusLabel(createdTask.status)}</strong>
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

/** 接口页协议卡的展示名称。 */
function interfaceProtocolName(protocol: AigcInterfaceProtocol): string {
  if (protocol === "openai") return "OpenAI";
  if (protocol === "grok") return "Grok";
  return "ComfyUI";
}

/** 接口页协议卡的简短能力说明。 */
function interfaceProtocolDescription(protocol: AigcInterfaceProtocol): string {
  if (protocol === "openai") return "图片生成与编辑";
  if (protocol === "grok") return "图片与视频全流程";
  return "工作流节点编排";
}

/** 将服务端接口记录转换成稳定的编辑表单基线。 */
function interfaceInputFromRecord(item: AigcInterfaceRecord): AigcInterfaceInput {
  return {
    name: item.name,
    description: item.description,
    protocol: item.protocol,
    capability: item.capability,
    channelId: item.channelId,
    enabled: item.enabled,
    toolPublishEnabled: item.toolPublishEnabled,
    config: item.config as AigcInterfaceInput["config"],
  };
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
  const [savedDraft, setSavedDraft] = useState<AigcInterfaceInput>(emptyInterface);
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState<(() => void) | undefined>();
  const [deleteTarget, setDeleteTarget] = useState<AigcInterfaceRecord>();
  const isDirty = JSON.stringify(draft) !== JSON.stringify(savedDraft);
  const navigationGuard = useAigcUnsavedNavigation(isDirty);

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
    if (isDirty) {
      setPendingAction(() => () => selectImmediately(item));
      return;
    }
    selectImmediately(item);
  }

  function selectImmediately(item: AigcInterfaceRecord) {
    const nextDraft: AigcInterfaceInput = {
      name: item.name,
      description: item.description,
      protocol: item.protocol,
      capability: item.capability,
      channelId: item.channelId,
      enabled: item.enabled,
      toolPublishEnabled: item.toolPublishEnabled,
      config: item.config as AigcInterfaceInput["config"],
    };
    setSelected(item);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
  }

  function createDraft() {
    if (isDirty) {
      setPendingAction(() => createImmediately);
      return;
    }
    createImmediately();
  }

  function createImmediately() {
    const nextDraft = { ...emptyInterface, channelId: channels.find((channel) => channel.enabled)?.id ?? "" };
    setSelected(undefined);
    setDraft(nextDraft);
    setSavedDraft(nextDraft);
  }

  function changeProtocol(protocol: AigcInterfaceProtocol) {
    setDraft((current) => ({
      ...current,
      protocol,
      capability: defaultCapability(protocol),
      channelId: channels.find((channel) => channel.type === protocol && channel.enabled)?.id ?? "",
      config: protocol === "comfyui" ? { workflowId: "" } : { model: "" },
    }));
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
      if (current) selectImmediately(current);
      setMessage("已保存 AIGC 接口");
    } catch {
      setMessage("刷新 AIGC 接口失败");
    }
  }

  async function remove() {
    if (!deleteTarget || !document || !online) return;
    setMessage("");
    const result = await runApiTask(() => api.deleteAigcInterface(deleteTarget.id, document.revision), { operation: "删除 AIGC 接口", expected: aigcExpected(setMessage) });
    if (result.status !== "success") return;
    await refresh();
    setSelected(undefined);
    setDraft(emptyInterface);
    setSavedDraft(emptyInterface);
    setDeleteTarget(undefined);
    setMessage("已删除 AIGC 接口");
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>接口</h1><p>把渠道、能力与 ComfyUI 工作流组合成可手动试运行的 AIGC 接口。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <div className="aigc-interface-workspace">
      <section className="configuration-section aigc-section">
        <div className="configuration-section__heading"><div><span>01</span><h2>接口列表</h2></div><button type="button" className="configuration-primary-action" onClick={createDraft} disabled={!online}><Boxes size={15} />新增接口</button></div>
        {(document?.interfaces ?? []).length ? (
          <div className="aigc-entity-list">
            {(document?.interfaces ?? []).map((item) => (
              <article key={item.id} className={selected?.id === item.id ? "aigc-task-row aigc-entity-row is-selected" : "aigc-task-row aigc-entity-row"}>
                <button type="button" className="aigc-entity-row__main" onClick={() => select(item)}>
                  <span className="aigc-entity-row__name">{item.name}</span>
                  <span className="aigc-entity-row__meta">{interfaceProtocolName(item.protocol)} · {capabilityLabel(item.protocol, item.capability)}</span>
                  <span className={item.enabled ? "aigc-status-badge is-enabled" : "aigc-status-badge"}>{item.enabled ? "已启用" : "已停用"}</span>
                </button>
              </article>
            ))}
          </div>
        ) : <p className="configuration-help">尚未创建 AIGC 接口。</p>}
      </section>

      <section className="configuration-form-card aigc-config-section">
        <div className="configuration-section__heading"><div><span>02</span><h2>{selected ? "编辑接口" : "新增接口"}</h2></div><small>{selected ? selected.name : "定义协议、能力和执行目标"}</small></div>
        <div className="aigc-form-stack">
          <label><span>接口名称</span><input aria-label="AIGC 接口名称" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
          <label><span>描述</span><textarea aria-label="AIGC 接口描述" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
        </div>

        <div className="aigc-fieldset">
          <div className="aigc-fieldset__heading"><strong>协议</strong><small>选择接口使用的第三方协议，能力会随协议变化</small></div>
          <div className="aigc-protocol-grid aigc-protocol-grid--compact">
            {(["openai", "grok", "comfyui"] as const).map((protocol) => (
              <button
                type="button"
                key={protocol}
                className={draft.protocol === protocol ? "aigc-overview-card aigc-protocol-card is-selected" : "aigc-overview-card aigc-protocol-card"}
                onClick={() => changeProtocol(protocol)}
              >
                <span className="aigc-protocol-card__name">{interfaceProtocolName(protocol)}</span>
                <span className="aigc-protocol-card__type">{protocol}</span>
                <small>{interfaceProtocolDescription(protocol)}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="aigc-fieldset">
          <div className="aigc-fieldset__heading"><strong>执行目标</strong><small>能力、渠道及模型或工作流共同决定最终调用方式</small></div>
          <div className="configuration-field-row">
            <label><span>能力</span><select aria-label="AIGC 接口能力" value={draft.capability} onChange={(event) => setDraft({ ...draft, capability: event.target.value as AigcInterfaceCapability })}>
              {capabilityOptions(draft.protocol).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></label>
            <label><span>渠道</span><select aria-label="AIGC 渠道" value={draft.channelId} onChange={(event) => setDraft({ ...draft, channelId: event.target.value })}>
              <option value="">请选择渠道</option>
              {channels.filter((channel) => channel.type === draft.protocol).map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
            </select></label>
          </div>
          {!channels.some((channel) => channel.type === draft.protocol) ? <p className="configuration-help">当前协议还没有可用渠道，请先到配置中心创建 {interfaceProtocolName(draft.protocol)} 渠道。</p> : null}
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
        </div>

        {draft.protocol === "grok" || draft.protocol === "openai" ? (
          <div className="aigc-fieldset">
            <div className="aigc-fieldset__heading"><strong>协议参数</strong><small>按需补充生成默认值；留空时由调用方传入</small></div>
            <div className="configuration-field-row">
              <label><span>默认尺寸</span><input aria-label={`${interfaceProtocolName(draft.protocol)} 默认尺寸`} placeholder="1024x1024" value={(draft.config as { size?: string }).size ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, size: event.target.value } })} /></label>
              {draft.protocol === "grok" ? <label><span>默认时长（秒）</span><input type="number" min={1} max={300} aria-label="Grok 默认时长" value={(draft.config as { duration?: number }).duration ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, duration: Number.isFinite(event.target.valueAsNumber) ? event.target.valueAsNumber : undefined } })} /></label> : <label><span>质量</span><input aria-label="OpenAI 质量" placeholder="standard" value={(draft.config as { quality?: string }).quality ?? ""} onChange={(event) => setDraft({ ...draft, config: { ...draft.config, quality: event.target.value } })} /></label>}
            </div>
          </div>
        ) : null}

        <div className="aigc-fieldset aigc-fieldset--checks">
          <label className="configuration-check-line"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /><span>启用接口</span></label>
          <label className="configuration-check-line"><input type="checkbox" checked={draft.toolPublishEnabled} onChange={(event) => setDraft({ ...draft, toolPublishEnabled: event.target.checked })} /><span>预留未来发布为 Agent 工具</span></label>
        </div>

        <div className="configuration-save-bar">
          <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!selected || !online} onClick={() => selected && setDeleteTarget(selected)}><Trash2 size={15} />删除</button>
          <button type="button" className="configuration-primary-action" disabled={!online || !isDirty} onClick={() => void save()}><Save size={16} />{isDirty ? "保存接口" : "已保存"}</button>
        </div>
      </section>
      </div>
      {pendingAction ? <ConfirmationDialog title="放弃未保存修改？" description="当前接口表单还有未保存内容。继续后，这些修改将丢失。" confirmLabel="放弃修改" destructive={false} onCancel={() => setPendingAction(undefined)} onConfirm={() => { const action = pendingAction; setPendingAction(undefined); action(); }} /> : null}
      {navigationGuard.pendingRoute ? <ConfirmationDialog title="离开并放弃修改？" description="当前接口表单还有未保存内容。离开页面后，这些修改将丢失。" confirmLabel="离开页面" destructive={false} onCancel={navigationGuard.cancel} onConfirm={navigationGuard.confirm} /> : null}
      {deleteTarget ? <ConfirmationDialog title={`删除接口“${deleteTarget.name}”？`} description="删除后无法恢复，引用该接口的创作入口将立即失效，历史任务仍会保留。" confirmLabel="删除接口" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} /> : null}
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
  const detailDirty = Boolean(item && JSON.stringify(draft) !== JSON.stringify(interfaceInputFromRecord(item)));
  const navigationGuard = useAigcUnsavedNavigation(detailDirty);

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
    if (result.status === "success") {
      setItem(result.data);
      setMessage("已保存 AIGC 接口");
    }
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
      {navigationGuard.pendingRoute ? <ConfirmationDialog title="离开并放弃修改？" description="接口详情仍有未保存内容。离开页面后，这些修改将丢失。" confirmLabel="离开页面" destructive={false} onCancel={navigationGuard.cancel} onConfirm={navigationGuard.confirm} /> : null}
    </div>
  );
}

/** 任务列表页。 */
function AigcTasksPage() {
  const { runApiTask } = useApiTask();
  const [document, setDocument] = useState<AigcTaskDocument>();
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "active" | "succeeded" | "failed">("all");

  async function refresh() {
    const next = await api.getAigcTasks();
    setDocument(next);
    return next;
  }

  useEffect(() => {
    void runApiTask(refresh, { operation: "加载 AIGC 任务" });
    const timer = window.setInterval(() => void refresh().catch(() => undefined), 3_000);
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

  const visibleTasks = (document?.tasks ?? []).filter((task) => {
    if (filter === "active") return task.status === "queued" || task.status === "running";
    if (filter === "failed") return task.status === "failed" || task.status === "cancelled";
    if (filter === "succeeded") return task.status === "succeeded";
    return true;
  });

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>任务与产物</h1><p>按创作状态查看进度、失败原因，并进入详情直接预览生成结果。</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <div className="scheduled-task-segmented aigc-task-filters" role="group" aria-label="任务状态筛选">
        {([{ value: "all", label: "全部" }, { value: "active", label: "进行中" }, { value: "succeeded", label: "已完成" }, { value: "failed", label: "需处理" }] as const).map((item) => <button key={item.value} type="button" className={filter === item.value ? "is-active" : undefined} onClick={() => setFilter(item.value)}>{item.label}</button>)}
      </div>
      <div className="aigc-task-list">
        {visibleTasks.map((task) => (
          <section key={task.id} className="aigc-task-row">
            <div><strong>{task.interfaceName}</strong><span className={`aigc-status-badge is-${task.status}`}>{taskStatusLabel(task.status)}</span><small>{formatAigcTime(task.createdAt)}</small></div>
            <p>{task.error ? task.error.message : task.status === "succeeded" ? `${task.assetCount} 个产物可预览` : task.status === "running" ? "正在生成，请保持页面打开或稍后回来查看" : "等待执行"}</p>
            <div className="aigc-task-actions">
              {(task.status === "queued" || task.status === "running") ? <button type="button" onClick={() => void cancel(task.id)}>取消</button> : null}
              {(task.status === "failed" || task.status === "cancelled") ? <button type="button" onClick={() => void retry(task.id)}><RefreshCw size={14} />重试</button> : null}
              <a href={`/aigc/tasks/${encodeURIComponent(task.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-task-detail", taskId: task.id }); }}>查看</a>
            </div>
          </section>
        ))}
        {!visibleTasks.length ? <p className="configuration-help">当前筛选下没有任务。</p> : null}
      </div>
    </div>
  );
}

/** 任务详情页。 */
function AigcTaskDetail({ taskId }: { taskId: string }) {
  const { runApiTask } = useApiTask();
  const [task, setTask] = useState<AigcTaskRecord>();
  const [message, setMessage] = useState("");
  const [previewAsset, setPreviewAsset] = useState<AigcTaskAsset>();

  useEffect(() => {
    void runApiTask(() => api.getAigcTask(taskId).then((next) => { setTask(next); return next; }), { operation: "加载 AIGC 任务详情" });
    const timer = window.setInterval(() => void api.getAigcTask(taskId).then(setTask).catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [runApiTask, taskId]);

  useEffect(() => {
    if (!previewAsset) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewAsset(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [previewAsset]);

  async function retry() {
    const result = await runApiTask(() => api.retryAigcTask(taskId), { operation: "重试 AIGC 任务", expected: aigcExpected(setMessage) });
    if (result.status === "success" && result.data) setTask(result.data);
  }

  if (!task) return <div className="aigc-workbench-page"><p className="configuration-help">正在加载任务…</p></div>;
  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>创作结果</h1><p>{task.interfaceName} · {taskStatusLabel(task.status)}</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="configuration-form-card">
        <div className="aigc-task-meta"><span>任务 ID</span><code>{task.id}</code></div>
        <div className="aigc-task-meta"><span>状态</span><strong className={`aigc-status-badge is-${task.status}`}>{taskStatusLabel(task.status)}</strong></div>
        <div className="aigc-task-meta"><span>创建时间</span><time>{formatAigcTime(task.createdAt)}</time></div>
        {typeof task.inputs.prompt === "string" && task.inputs.prompt ? <div className="aigc-task-prompt"><span>创作描述</span><p>{task.inputs.prompt}</p></div> : null}
        {task.error ? <p className="configuration-help">错误：{task.error.code} {task.error.message}</p> : null}
        <div className="configuration-section__heading"><div><span>01</span><h2>产物预览</h2></div><small>{task.assets.length} 个文件</small></div>
        <div className="aigc-asset-gallery">
          {task.assets.map((asset) => {
            const source = aigcTaskAssetUrl(task.id, asset.id);
            return (
              <figure key={asset.id} className="media-attachment aigc-asset-card">
                <div className="media-attachment__preview">
                  {asset.mediaType.startsWith("image/") ? <button type="button" className="media-attachment__open" aria-label={`放大预览 ${asset.name}`} onClick={() => setPreviewAsset(asset)}><img src={source} alt={asset.name} loading="lazy" /></button> : null}
                  {asset.mediaType.startsWith("video/") ? <video src={source} controls preload="metadata" aria-label={asset.name} /> : null}
                  {asset.mediaType.startsWith("audio/") ? <audio src={source} controls preload="metadata" aria-label={asset.name} /> : null}
                  {!asset.mediaType.startsWith("image/") && !asset.mediaType.startsWith("video/") && !asset.mediaType.startsWith("audio/") ? <div className="media-attachment__file"><span>{asset.mediaType}</span></div> : null}
                </div>
                <figcaption><span><strong>{asset.name}</strong><small>{formatFileSize(asset.size)} · {asset.mediaType}</small></span><a href={aigcTaskAssetUrl(task.id, asset.id, true)} download={asset.name} aria-label="下载"><Download size={15} /><span>下载</span></a></figcaption>
              </figure>
            );
          })}
        </div>
        {!task.assets.length ? <p className="configuration-help">{task.status === "succeeded" ? "任务已完成，但没有提取到产物，请检查接口或工作流输出映射。" : "生成完成后，图片、视频和音频会直接显示在这里。"}</p> : null}
        {(task.status === "failed" || task.status === "cancelled") ? <button type="button" className="configuration-secondary-action" onClick={() => void retry()}><RefreshCw size={15} />重试</button> : null}
      </section>
      {previewAsset ? <div className="media-lightbox" role="dialog" aria-modal="true" aria-label={`${previewAsset.name} 大图预览`}><button type="button" className="media-lightbox__close" aria-label="关闭产物预览" onClick={() => setPreviewAsset(undefined)}><X size={20} /></button><div className="media-lightbox__stage"><img src={aigcTaskAssetUrl(task.id, previewAsset.id)} alt={previewAsset.name} /></div></div> : null}
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
  const [interfaces, setInterfaces] = useState<AigcInterfaceRecord[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<AigcWorkflowSummary>();

  async function refresh() {
    const [next, interfaceDocument] = await Promise.all([api.getAigcWorkflows(), api.getAigcInterfaces()]);
    setDocument(next);
    setInterfaces(interfaceDocument.interfaces);
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

  async function remove() {
    if (!document || !deleteTarget) return;
    const result = await runApiTask(() => api.deleteAigcWorkflow(deleteTarget.id, document.revision), { operation: "删除 ComfyUI 工作流", expected: aigcExpected(setMessage) });
    if (result.status === "success") {
      setDeleteTarget(undefined);
      await refresh();
    }
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
            <div className="aigc-task-actions">
              {interfaces.find((item) => item.enabled && item.protocol === "comfyui" && (item.config as { workflowId?: string }).workflowId === workflow.id) ? <button type="button" onClick={() => { const item = interfaces.find((candidate) => candidate.enabled && candidate.protocol === "comfyui" && (candidate.config as { workflowId?: string }).workflowId === workflow.id); if (item) navigateTo({ page: "aigc-run", interfaceId: item.id }); }}><Play size={14} />运行</button> : <button type="button" onClick={() => navigateTo({ page: "aigc-interfaces" })}><Boxes size={14} />创建运行接口</button>}
              <a href={`/aigc/workflows/${encodeURIComponent(workflow.id)}`} onClick={(event) => { event.preventDefault(); navigateTo({ page: "aigc-workflow-detail", workflowId: workflow.id }); }}>配置映射</a>
              <button type="button" onClick={() => setDeleteTarget(workflow)}><Trash2 size={14} />删除</button>
            </div>
          </section>
        ))}
        {!document?.workflows.length ? <p className="configuration-help">尚未导入工作流。</p> : null}
      </div>
      {deleteTarget ? <ConfirmationDialog title={`删除工作流“${deleteTarget.name}”？`} description={`删除后无法恢复。${interfaces.filter((item) => item.protocol === "comfyui" && (item.config as { workflowId?: string }).workflowId === deleteTarget.id).length} 个接口正在引用它，相关创作入口将无法运行。`} confirmLabel="删除工作流" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => void remove()} /> : null}
    </div>
  );
}

/** 工作流详情页，提供节点与字段点选的可视化映射编排。 */
function AigcWorkflowDetail({ workflowId }: { workflowId: string }) {
  const { runApiTask } = useApiTask();
  const [detail, setDetail] = useState<AigcWorkflowDetail>();
  const [revision, setRevision] = useState("");
  const [name, setName] = useState("");
  const [inputMappings, setInputMappings] = useState<AigcWorkflowInputMapping[]>([]);
  const [outputMappings, setOutputMappings] = useState<AigcWorkflowOutputMapping[]>([]);
  const [message, setMessage] = useState("");
  const isDirty = Boolean(detail && (name !== detail.name || JSON.stringify(inputMappings) !== JSON.stringify(detail.inputMappings) || JSON.stringify(outputMappings) !== JSON.stringify(detail.outputMappings)));
  const navigationGuard = useAigcUnsavedNavigation(isDirty);

  useEffect(() => {
    void runApiTask(async () => {
      const next = await api.getAigcWorkflow(workflowId);
      setDetail(next.workflow);
      setRevision(next.revision);
      setName(next.workflow.name);
      setInputMappings(next.workflow.inputMappings);
      setOutputMappings(next.workflow.outputMappings);
      return next;
    }, { operation: "加载 ComfyUI 工作流详情" });
  }, [runApiTask, workflowId]);

  async function save() {
    const result = await runApiTask(() => api.updateAigcWorkflow(workflowId, revision, { name, inputMappings, outputMappings }), {
      operation: "保存 ComfyUI 工作流映射",
      expected: aigcExpected(setMessage),
    });
    if (result.status === "success") {
      setMessage("已保存工作流映射");
      const next = await api.getAigcWorkflow(workflowId);
      setRevision(next.revision);
      setDetail(next.workflow);
      setInputMappings(next.workflow.inputMappings);
      setOutputMappings(next.workflow.outputMappings);
    }
  }

  return (
    <div className="aigc-workbench-page">
      <header className="aigc-page-heading"><h1>工作流详情</h1><p>{detail?.fileName ?? workflowId}</p></header>
      {message ? <p className="configuration-help" role="status">{message}</p> : null}
      {detail ? (
        <AigcWorkflowComposer
          workflow={detail}
          name={name}
          onNameChange={setName}
          inputMappings={inputMappings}
          outputMappings={outputMappings}
          onInputMappingsChange={setInputMappings}
          onOutputMappingsChange={setOutputMappings}
        />
      ) : <p className="configuration-help">正在加载工作流节点…</p>}
      <div className="configuration-save-bar">
        <button type="button" className="configuration-primary-action" disabled={!detail || !isDirty} onClick={() => void save()}><Save size={15} />{isDirty ? "保存映射" : "已保存"}</button>
      </div>
      {navigationGuard.pendingRoute ? <ConfirmationDialog title="离开并放弃修改？" description="工作流映射仍有未保存内容。离开页面后，这些修改将丢失。" confirmLabel="离开页面" destructive={false} onCancel={navigationGuard.cancel} onConfirm={navigationGuard.confirm} /> : null}
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

/** 将内部任务状态转换为面向创作者的中文状态。 */
function taskStatusLabel(status: AigcTaskStatus): string {
  if (status === "queued") return "等待中";
  if (status === "running") return "生成中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "生成失败";
  return "已取消";
}

/** 使用稳定中文格式展示 AIGC 任务时间。 */
function formatAigcTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

/** 以便于识别的单位展示产物大小。 */
function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
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
