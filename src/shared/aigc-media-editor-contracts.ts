/** 轻剪辑支持的工程类型。 */
export type AigcMediaProjectKind = "video" | "audio";

/** 单轨时间线支持的片段类型。 */
export type AigcMediaClipKind = "image" | "video" | "audio";

/** 片段引用的原始 AIGC 任务产物。 */
export interface AigcMediaClipSource {
  taskId: string;
  assetId: string;
}

/** 浏览器提交的片段编辑状态。 */
export interface AigcMediaClipInput {
  id: string;
  source: AigcMediaClipSource;
  trimStartMs: number;
  trimEndMs?: number;
  imageDurationMs?: number;
  muted?: boolean;
}

/** 服务端校验并补齐媒体元数据后的时间线片段。 */
export interface AigcMediaClip extends AigcMediaClipInput {
  name: string;
  mediaType: string;
  kind: AigcMediaClipKind;
  sourceDurationMs: number;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

/** 持久化的单轨轻剪辑工程。 */
export interface AigcMediaProject {
  id: string;
  revision: string;
  name: string;
  kind: AigcMediaProjectKind;
  clips: AigcMediaClip[];
  latestRenderId?: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建空剪辑工程的输入。 */
export interface AigcMediaProjectCreateInput {
  name?: string;
  kind: AigcMediaProjectKind;
}

/** 原子保存工程名称和完整时间线。 */
export interface AigcMediaProjectUpdateInput {
  revision: string;
  name: string;
  clips: AigcMediaClipInput[];
}

/** 服务端媒体渲染任务状态。 */
export type AigcMediaRenderStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 单次导出任务及其资源受控状态。 */
export interface AigcMediaRenderJob {
  id: string;
  projectId: string;
  projectName: string;
  kind: AigcMediaProjectKind;
  status: AigcMediaRenderStatus;
  progress: number;
  queuePosition?: number;
  fileName?: string;
  mediaType?: string;
  size?: number;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 工程列表响应。 */
export interface AigcMediaProjectDocument {
  projects: AigcMediaProject[];
}
