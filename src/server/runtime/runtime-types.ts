import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { PiRuntimeGateway } from "../pi-runtime";

/** 创建单个 Agent Runtime 所需的稳定上下文。 */
export interface AgentRuntimeContext {
  agentId: string;
  cwd: string;
  modelRuntime: ModelRuntime;
}

/** 对某一代 Runtime 的独占生命周期引用。 */
export interface RuntimeLease {
  readonly runtime: PiRuntimeGateway;
  readonly generation: number;
  /** Runtime 代次退休时完成，长连接应结束并重新获取当前代。 */
  readonly retired: Promise<void>;
  release(): void;
}
