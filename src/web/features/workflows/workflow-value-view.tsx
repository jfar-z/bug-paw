import { useState } from "react";
import type { WorkflowFile } from "../../../shared/workflow-contracts";
import { ApiClientError } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { ConfigurationEditorDialog } from "../../components/configuration/configuration-editor-dialog";

/** 递归收集嵌套产物并按资产去重，同一文件可通过多个输出字段返回。 */
export function workflowOutputFiles(value: unknown): WorkflowFile[] {
  const files = new Map<string, WorkflowFile>();
  const visit = (item: unknown) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") {
      if (
        "assetId" in item &&
        typeof item.assetId === "string" &&
        "mediaType" in item &&
        typeof item.mediaType === "string"
      )
        files.set(item.assetId, item as WorkflowFile);
      else Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return [...files.values()];
}

/** 预览和下载复用认证资产路由，浏览器解码错误也进入统一错误弹窗。 */
function WorkflowMediaItem({ file }: { file: WorkflowFile }) {
  const { runApiTask } = useApiTask();
  const [large, setLarge] = useState(false);
  const [failed, setFailed] = useState(false);
  const download = `/api/v1/workflow-files/${encodeURIComponent(file.assetId)}`;
  const preview = `${download}?preview=1`;
  const image = file.mediaType.startsWith("image/");
  const error = (code?: number) => {
    setFailed(true);
    void runApiTask(
      async () => {
        throw new ApiClientError(
          "WORKFLOW_MEDIA_PREVIEW_FAILED",
          `工作流产物 ${file.name}（${file.mediaType}）加载或解码失败${code ? `，浏览器媒体错误码 ${code}` : ""}；请检查文件是否仍存在、登录是否有效及浏览器是否支持该格式。`,
          0,
        );
      },
      { operation: "预览工作流媒体产物" },
    );
  };
  return (
    <article className="wf-media-item">
      {image && (
        <button
          type="button"
          className="wf-media-image"
          aria-label={`查看大图 ${file.name}`}
          onClick={() => setLarge(true)}
        >
          <img
            src={preview}
            alt={file.name}
            loading="lazy"
            onError={() => error()}
          />
        </button>
      )}
      {file.mediaType.startsWith("video/") && (
        <video
          src={preview}
          controls
          preload="metadata"
          aria-label={file.name}
          onError={(event) => error(event.currentTarget.error?.code)}
        />
      )}
      {file.mediaType.startsWith("audio/") && (
        <audio
          src={preview}
          controls
          preload="metadata"
          aria-label={file.name}
          onError={(event) => error(event.currentTarget.error?.code)}
        />
      )}
      {failed && <p className="wf-error">媒体预览不可用，可下载文件检查。</p>}
      <div className="wf-output-row">
        <strong>{file.name}</strong>
        <a className="wf-file-link" href={download} download={file.name}>
          下载
        </a>
      </div>
      {large && (
        <ConfigurationEditorDialog
          variant="confirmation"
          title={file.name}
          description="图片原图预览"
          closeLabel="关闭图片预览"
          busy={false}
          onClose={() => setLarge(false)}
          footer={
            <button
              type="button"
              className="configuration-secondary-action"
              onClick={() => setLarge(false)}
            >
              关闭图片预览
            </button>
          }
        >
          <div className="wf-media-large">
            <img src={preview} alt={file.name} onError={() => error()} />
          </div>
        </ConfigurationEditorDialog>
      )}
    </article>
  );
}

/** 媒体产物优先呈现预览；原始结构保留供运行排查。 */
export function WorkflowValueView({ value }: { value: unknown }) {
  const files = workflowOutputFiles(value);
  const json = (
    <pre className="wf-json-output">{JSON.stringify(value ?? {}, null, 2)}</pre>
  );
  return (
    <>
      {files.length ? (
        <>
          <div className="wf-media-list">
            {files.map((file) => (
              <WorkflowMediaItem key={file.assetId} file={file} />
            ))}
          </div>
          <details className="wf-output-data">
            <summary>查看完整输出数据</summary>
            {json}
          </details>
        </>
      ) : (
        json
      )}
    </>
  );
}
