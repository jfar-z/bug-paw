import type {
  AigcChannelConfig,
  AigcInterfaceRecord,
} from "../../shared/aigc-contracts";
import type { AigcAssetService } from "./aigc-asset-service";
import type { AigcWorkflowService } from "./aigc-workflow-service";

export interface AigcExecutionInput {
  item: AigcInterfaceRecord;
  channel: AigcChannelConfig;
  apiKey?: string;
  inputs: Record<string, unknown>;
  assets: AigcAssetService;
  workflows?: AigcWorkflowService;
  signal: AbortSignal;
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
