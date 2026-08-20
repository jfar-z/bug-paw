import type {
  AigcChannelConfig,
  AigcInterfaceRecord,
  AigcTaskExecutionState,
} from "../../shared/aigc-contracts";
import type { AigcAssetService } from "./aigc-asset-service";
import type { AigcPublicFileService } from "./aigc-public-file-service";
import type { AigcWorkflowService } from "./aigc-workflow-service";

export interface AigcExecutionInput {
  item: AigcInterfaceRecord;
  channel: AigcChannelConfig;
  apiKey?: string;
  inputs: Record<string, unknown>;
  assets: AigcAssetService;
  publicFiles?: AigcPublicFileService;
  workflows?: AigcWorkflowService;
  signal: AbortSignal;
  /** 上报执行中的瞬态进度，调用方不得在此执行高频持久化。 */
  onProgress?: (state: AigcTaskExecutionState) => void;
}

export interface AigcExecutionAsset {
  name: string;
  mediaType: string;
  content: Buffer;
}

export interface AigcExecutionResult {
  assets: AigcExecutionAsset[];
}

/** 统一协议适配器接口。 */
export interface AigcProtocolAdapter {
  execute(input: AigcExecutionInput): Promise<AigcExecutionResult>;
}
