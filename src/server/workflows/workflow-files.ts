import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { WorkflowFile } from "../../shared/workflow-contracts";
import { AigcAssetService } from "../aigc/aigc-asset-service";
import type { WorkspaceFileManager } from "../workspace-files";
import type { WorkspaceFileService } from "../attachments";
import { readJson, writeJsonAtomic } from "../storage";
import { DomainError } from "../core/errors";
import { record } from "./workflow-validation";

interface StoredFile extends WorkflowFile {
  owner?: string;
}
/** 工作流媒体有独立资产目录与归属；Agent 只能输入其工作区文件。 */
export class WorkflowFiles {
  private readonly assets: AigcAssetService;
  constructor(
    private readonly directory: string,
    private readonly workspace: WorkspaceFileManager,
    private readonly files: WorkspaceFileService,
  ) {
    this.assets = new AigcAssetService(directory);
  }
  async upload(
    stream: Readable,
    name: string,
    mediaType: string,
    owner?: string,
  ): Promise<WorkflowFile> {
    const saved = await this.assets.saveInput(stream, name, mediaType);
    if ((stream as Readable & { truncated?: boolean }).truncated) {
      await this.assets.removeInput(saved.id);
      throw new DomainError(
        "INVALID_ATTACHMENT",
        "文件上传超过大小限制，未保存截断内容",
      );
    }
    const file: StoredFile = {
      assetId: saved.id,
      name: saved.name,
      mediaType: saved.mediaType,
      size: saved.size,
      owner,
    };
    await writeJsonAtomic(
      join(this.directory, "metadata", `${file.assetId}.json`),
      file,
    );
    return this.public(file);
  }
  async importPath(agentId: string, path: string): Promise<WorkflowFile> {
    const file = await this.workspace.readFile(
      agentId,
      path,
      100 * 1024 * 1024,
    );
    return this.upload(
      Readable.from(file.content),
      file.name,
      file.mediaType,
      agentId,
    );
  }
  /** 不信任调用方提交的文件名、类型或大小，始终读取资产元数据。 */
  async resolve(
    value: unknown,
    owner?: string,
  ): Promise<{ file: WorkflowFile; path: string }> {
    if (
      !record(value) ||
      typeof value.assetId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(value.assetId)
    )
      throw new DomainError("INVALID_ATTACHMENT", "工作流文件引用不合法");
    const stored = await readJson<StoredFile>(
      join(this.directory, "metadata", `${value.assetId}.json`),
    );
    if (!stored || (owner !== undefined && stored.owner !== owner))
      throw new DomainError(
        "INVALID_ATTACHMENT",
        "工作流文件不存在或不属于当前 Agent",
      );
    const path = await this.assets.resolveInputPath(stored.assetId);
    if (!path)
      throw new DomainError("INVALID_ATTACHMENT", "工作流文件内容已不存在");
    return { file: this.public(stored), path };
  }
  async buffer(
    value: unknown,
    owner?: string,
    limit = 100 * 1024 * 1024,
  ): Promise<{ file: WorkflowFile; content: Buffer }> {
    const { file, path } = await this.resolve(value, owner);
    if ((await stat(path)).size > limit)
      throw new DomainError(
        "INVALID_ATTACHMENT",
        "工作流文件超过当前节点的大小限制",
      );
    return { file, content: await readFile(path) };
  }
  async toWorkspace(
    value: unknown,
    targetAgent: string,
    owner?: string,
  ): Promise<{ path: string; name: string; mediaType: string; size: number }> {
    const { file, path } = await this.resolve(value, owner);
    const saved = await this.files.saveUpload(
      targetAgent,
      file.name,
      file.mediaType,
      createReadStream(path),
    );
    return {
      path: saved.path,
      name: saved.name,
      mediaType: saved.mediaType,
      size: saved.size,
    };
  }
  private public(file: StoredFile): WorkflowFile {
    return {
      assetId: file.assetId,
      name: file.name,
      mediaType: file.mediaType,
      size: file.size,
    };
  }
}
