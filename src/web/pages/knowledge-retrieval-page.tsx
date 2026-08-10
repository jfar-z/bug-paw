import { DatabaseZap, RefreshCw, Save } from "lucide-react";
import { useEffect, useState } from "react";

import type { EmbeddingConfigInput } from "../../shared/knowledge-retrieval-contracts";
import { api } from "../api";
import { SecretInput } from "../components/secret-input";
import { useOnlineStatus } from "../use-online-status";

const CACHE_KEY = "pi-agent:knowledge-retrieval-cache";
const emptyDraft = (): EmbeddingConfigInput => ({ baseUrl: "", model: "", batchSize: 32, apiKey: "", enabled: true });

/** 配置语义检索服务，并控制资料上传时是否建立向量索引。 */
export function KnowledgeRetrievalPage() {
  const online = useOnlineStatus();
  const [revision, setRevision] = useState("");
  const [draft, setDraft] = useState<EmbeddingConfigInput>(emptyDraft);
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [hasApiKey, setHasApiKey] = useState(false);
  const [isManaged, setIsManaged] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const cached = readCache();
    if (cached) applyDocument(cached, setRevision, setDraft, setHasApiKey, setIsManaged);
    void api.getKnowledgeRetrieval().then((document) => {
      applyDocument(document, setRevision, setDraft, setHasApiKey, setIsManaged);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(document));
    }).catch(() => setMessage(cached ? "正在显示上次缓存的配置；离线时不能保存或重建。" : "无法读取 Embedding 配置"));
  }, []);

  const update = <K extends keyof EmbeddingConfigInput>(key: K, value: EmbeddingConfigInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const toggleApiKeyVisibility = async () => {
    if (apiKeyVisible) { setApiKeyVisible(false); return; }
    if (isManaged) return;
    try {
      if (hasApiKey && !draft.apiKey) {
        const value = await api.getKnowledgeRetrievalCredential();
        update("apiKey", value.apiKey);
      }
      setApiKeyVisible(true);
    } catch (error) { setMessage(error instanceof Error ? error.message : "无法读取 API Key"); }
  };
  const save = async () => {
    if (!online) return;
    setBusy(true); setMessage("");
    try {
      const document = await api.updateKnowledgeRetrieval(revision, draft);
      applyDocument(document, setRevision, setDraft, setHasApiKey, setIsManaged);
      window.localStorage.setItem(CACHE_KEY, JSON.stringify(document));
      setMessage(draft.enabled
        ? "Embedding 配置已保存；更换模型或重新启用后，请手动重建已有知识库的语义索引。"
        : "已关闭语义检索；后续上传资料只会建立全文索引。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setBusy(false); }
  };
  const rebuild = async () => {
    if (!online) return;
    setBusy(true); setMessage("");
    try {
      const result = await api.rebuildKnowledgeRetrieval();
      setMessage(result.failedBases.length ? `已重建 ${result.rebuiltBases}/${result.totalBases} 个知识库，部分知识库未完成。` : `已重建 ${result.rebuiltBases} 个知识库的语义索引。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "重建失败"); }
    finally { setBusy(false); }
  };
  return <main className="configuration-page"><header className="configuration-page__heading"><h1>Embedding 与语义检索</h1><p>内置中文模型已可用，也可配置 OpenAI Embeddings 兼容接口。密钥默认隐藏，点击小眼睛可按需查看。</p></header>
    {message ? <p className="configuration-help" role="status">{message}</p> : null}
    <section className="configuration-form-card"><div className="configuration-section__heading"><div><span>01</span><h2>Embedding 模型</h2></div></div>
      <label className="configuration-capability-toggle"><span>启用语义检索<small>{draft.enabled ? "上传资料会自动建立全文和语义索引。更换模型后请手动重建。" : "关闭后资料仅建立全文索引；重新启用后请手动重建语义索引。"}</small></span><input aria-label="启用语义检索" type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} /></label>
      <label><span>API Base URL</span><input aria-label="Embedding API Base URL" placeholder="https://example.com/v1" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
      <label><span>模型</span><input aria-label="Embedding 模型" value={draft.model} onChange={(event) => update("model", event.target.value)} /></label>
      <label><span>每批切片数{isManaged ? <small>内置服务单次最多处理 4 个切片。</small> : null}</span><input aria-label="每批切片数" type="number" min="1" max={isManaged ? 4 : 128} value={draft.batchSize} onChange={(event) => update("batchSize", Number(event.target.value))} /></label>
      <label><span>API Key<small>{isManaged ? "内置服务无需 API Key；保存可改为外部服务" : hasApiKey ? "留空则保留已配置密钥" : "仅保存到服务端"}</small></span><SecretInput aria-label="Embedding API Key" autoComplete="new-password" value={draft.apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => update("apiKey", event.target.value)} /></label>
    </section>
    <div className="configuration-save-bar"><button type="button" className="configuration-secondary-action" disabled={!online || busy || !draft.enabled || (!hasApiKey && !isManaged)} onClick={() => void rebuild()}><RefreshCw size={16} />{busy ? "处理中…" : "手动重建索引"}</button><button type="button" className="configuration-primary-action" disabled={!online || busy} onClick={() => void save()}><Save size={16} />保存配置</button></div>
    <p className="configuration-help"><DatabaseZap size={15} />{draft.enabled ? "日常上传会自动建立索引；重建期间，原有全文检索仍可使用。" : "语义检索已关闭，查询将仅使用全文索引。"}</p>
  </main>;
}

/** 从离线缓存读取脱敏配置，损坏缓存直接忽略。 */
function readCache(): unknown {
  try { return JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? ""); } catch { return undefined; }
}

/** 将服务端或缓存文档映射到表单状态。 */
function applyDocument(document: unknown, setRevision: (value: string) => void, setDraft: (value: EmbeddingConfigInput) => void, setHasApiKey: (value: boolean) => void, setIsManaged: (value: boolean) => void): void {
  if (typeof document !== "object" || document === null) return;
  const value = document as { revision?: unknown; config?: { baseUrl?: unknown; model?: unknown; batchSize?: unknown; hasApiKey?: unknown; isManaged?: unknown; enabled?: unknown } };
  if (typeof value.revision === "string") setRevision(value.revision);
  if (!value.config || typeof value.config.baseUrl !== "string" || typeof value.config.model !== "string" || typeof value.config.batchSize !== "number") return;
  setDraft({ baseUrl: value.config.baseUrl, model: value.config.model, batchSize: value.config.batchSize, apiKey: "", enabled: value.config.enabled !== false });
  setHasApiKey(value.config.hasApiKey === true);
  setIsManaged(value.config.isManaged === true);
}
