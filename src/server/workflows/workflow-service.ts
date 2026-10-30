import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  WorkflowDefinition,
  WorkflowSummary,
  WorkflowDraft,
  WorkflowRun,
  WorkflowNode,
  WorkflowBinding,
  WorkflowCondition,
  WorkflowNodeRun,
  WorkflowCatalog,
} from "../../shared/workflow-contracts";
import { DomainError, toSafePublicMessage } from "../core/errors";
import { KeyedMutex } from "../core/keyed-mutex";
import { WorkflowRepository } from "./workflow-repository";
import {
  checkValueSize,
  invalid,
  record,
  validateValues,
  validateWorkflow,
} from "./workflow-validation";
import {
  snapshotWorkflowDependencies,
  workflowDependencies,
} from "./workflow-dependencies";
import { WorkflowExecutionBudget } from "./workflow-execution-budget";
import { runWorkflowScript } from "./workflow-script";

export interface WorkflowExecutionContext {
  run: WorkflowRun;
  node: WorkflowNode;
  signal: AbortSignal;
  referenceGroups?: Record<string, unknown>;
  progress(message: string): Promise<void>;
}
export interface WorkflowExecutor {
  execute(
    context: WorkflowExecutionContext,
    inputs: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  validate?(
    definition: WorkflowDefinition,
    origin?: WorkflowRun["origin"],
  ): Promise<void>;
}
/** DAG 调度器负责幂等、快照、分支、有限并发、取消与持久化观测。 */
export class WorkflowService {
  private readonly runs = new Map<string, WorkflowRun>();
  private readonly executions = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private readonly lock = new KeyedMutex();
  private closing = false;
  constructor(
    private readonly repository: WorkflowRepository,
    private readonly executor: WorkflowExecutor,
    private readonly backgroundError: (error: Error) => void = () => undefined,
    private readonly checkFiles?: (definition: WorkflowDraft, inputs?: unknown) => Promise<void>,
  ) {}
  /** 重启后不重复提交可能计费的节点；中断运行明确标记失败。 */
  async initialize(): Promise<void> {
    for (const run of await this.repository.runs()) {
      if (["queued", "running"].includes(run.status)) {
        run.status = "failed";
        run.finishedAt = new Date().toISOString();
        run.error = {
          code: "WORKFLOW_INTERRUPTED",
          message:
            "服务重启导致工作流中断；未自动重试，请检查上游任务后重新运行",
          requestId: run.id,
        };
        const interrupt = (scope: WorkflowRun) => {
          if (scope !== run && ["queued", "running"].includes(scope.status)) {
            scope.status = "failed";
            scope.error = run.error;
            scope.finishedAt = run.finishedAt;
          }
          for (const n of scope.nodes) {
            if (n.status === "queued") n.status = "skipped";
            else if (n.status === "running") {
              n.status = "failed";
              n.error = run.error;
            }
            if (!n.finishedAt) n.finishedAt = run.finishedAt;
            for (const child of n.children ?? []) interrupt(child);
          }
        };
        interrupt(run);
        await this.repository.saveRun(run);
      }
      this.runs.set(run.id, run);
    }
  }
  async list(): Promise<WorkflowSummary[]> {
    return this.repository.definitions();
  }
  /** 目录单项损坏以明确禁用原因呈现，不阻止其他工作流继续选择。 */
  catalogWorkflows(): NonNullable<WorkflowCatalog["workflows"]> {
    return this.repository.definitions().map((summary) => {
      try {
        const definition = this.repository.definition(summary.id)!;
        const snapshots = snapshotWorkflowDependencies(definition, (id) =>
          this.repository.definition(id),
        );
        return {
          id: summary.id,
          name: summary.name,
          dependencies: Object.keys(snapshots),
          enumFields: definition.nodes
            .find((node) => node.kind === "input")!
            .outputs.filter((field) => field.enumValues?.length)
            .map((field) => ({
              name: field.name,
              values: field.enumValues!.map(String),
            })),
        };
      } catch (error) {
        return {
          id: summary.id,
          name: summary.name,
          dependencies: [],
          unavailable: toSafePublicMessage(
            error,
            `读取工作流 ${summary.name} 的调用依赖时未返回可读异常`,
          ),
        };
      }
    });
  }
  /** 校验未保存草稿时仍使用当前真实 ID，避免遗漏指向自身的间接环路。 */
  validate(draft: WorkflowDraft, id?: string): void {
    validateWorkflow(draft, true);
    const now = new Date().toISOString();
    snapshotWorkflowDependencies(
      {
        ...draft,
        id: id ?? randomUUID(),
        revision: 1,
        createdAt: now,
        updatedAt: now,
      },
      (key) => this.repository.definition(key),
      true,
    );
  }
  async get(id: string): Promise<WorkflowDefinition> {
    const item = this.repository.definition(id);
    if (!item) throw new DomainError("NOT_FOUND", "工作流不存在");
    return item;
  }
  async save(
    draft: WorkflowDraft,
    id?: string,
    revision?: number,
  ): Promise<WorkflowDefinition> {
    return this.withFileMutation(async () => {
      validateWorkflow(draft, record(draft) && draft.published === true);
      await this.checkFiles?.(draft);
      const targetId = id ?? randomUUID();
      return this.repository.mutateDefinition(targetId, (current) => {
        if (id && !current) throw new DomainError("NOT_FOUND", "工作流不存在");
        if (current && current.revision !== revision)
          throw new DomainError(
            "VERSION_CONFLICT",
            "工作流已被其他页面修改，请重新加载后编辑",
          );
        const now = new Date().toISOString();
        const next: WorkflowDefinition = {
          ...structuredClone({
            name: draft.name,
            description: draft.description,
            published: draft.published,
            nodes: draft.nodes,
            edges: draft.edges,
          }),
          id: targetId,
          revision: (current?.revision ?? 0) + 1,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        snapshotWorkflowDependencies(
          next,
          (key) => this.repository.definition(key),
          next.published,
        );
        return { value: next, result: next };
      });
    });
  }
  async remove(id: string, revision: number): Promise<void> {
    await this.lock.run("submit", async () =>
      this.repository.mutateDefinition(id, (current) => {
        if (!current) throw new DomainError("NOT_FOUND", "工作流不存在");
        if (current.revision !== revision)
          throw new DomainError(
            "VERSION_CONFLICT",
            "工作流版本已改变，请刷新列表",
          );
        if (
          [...this.runs.values()].some(
            (r) =>
              r.workflowId === id && ["running", "queued"].includes(r.status),
          )
        )
          throw new DomainError(
            "CONFLICT",
            "工作流仍有运行中任务，请先取消或等待完成",
          );
        for (const other of this.repository.definitions()) {
          if (other.id === id) continue;
          const definition = this.repository.definition(other.id)!;
          if (workflowDependencies(definition).includes(id))
            throw new DomainError(
              "CONFLICT",
              `工作流仍被“${other.name}”引用，请先移除调用节点`,
            );
        }
        return { result: undefined };
      }),
    );
  }
  /** 文件删除与定义保存、任务启动共用临界区，防止引用检查后出现竞争。 */
  withFileMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.lock.run("submit", operation);
  }
  /** 文件索引只读快照；避免为每个文件列表深拷贝全部运行正文。 */
  fileUsageSnapshot(): { definitions: WorkflowDefinition[]; runs: readonly WorkflowRun[] } {
    return { definitions: this.repository.definitions().map((item) => this.repository.definition(item.id)!), runs: [...this.runs.values()] };
  }
  listRuns(origin?: WorkflowRun["origin"]): WorkflowRun[] {
    return [...this.runs.values()]
      .filter((r) => !origin || r.origin?.agentId === origin.agentId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => structuredClone(r));
  }
  getRun(id: string, origin?: WorkflowRun["origin"]): WorkflowRun {
    const run = this.runs.get(id);
    if (!run || (origin && run.origin?.agentId !== origin.agentId))
      throw new DomainError(
        "NOT_FOUND",
        "当前调用方无权访问此工作流任务或任务不存在",
      );
    return structuredClone(run);
  }
  /** 同一会话的 requestKey 保持稳定，参数变更时拒绝重用。 */
  async start(
    workflowId: string,
    inputs: Record<string, unknown>,
    requestKey: string,
    origin?: WorkflowRun["origin"],
    idempotencyInputs: Record<string, unknown> = inputs,
  ): Promise<WorkflowRun> {
    return this.lock.run("submit", async () => {
      if (this.closing) throw new DomainError("CONFLICT", "工作流服务正在关闭");
      if (
        typeof requestKey !== "string" ||
        !/^[A-Za-z0-9_-]{1,80}$/.test(requestKey)
      )
        invalid("requestKey 必须为 1 到 80 位字母、数字、下划线或连字符");
      checkValueSize(inputs);
      const hash = createHash("sha256")
        .update(stableJson({ workflowId, inputs: idempotencyInputs })!)
        .digest("hex");
      const existing = [...this.runs.values()].find(
        (r) =>
          r.origin?.agentId === origin?.agentId &&
          r.origin?.sessionId === origin?.sessionId &&
          r.requestKey === requestKey,
      );
      if (existing) {
        if (existing.requestHash !== hash)
          throw new DomainError(
            "CONFLICT",
            "同一 requestKey 的工作流或参数已变化",
          );
        return this.getRun(existing.id, origin);
      }
      const definition = await this.get(workflowId);
      if (origin && !definition.published)
        throw new DomainError("FORBIDDEN", "工作流未发布为 Agent 工具");
      validateWorkflow(definition, true);
      const dependencies = snapshotWorkflowDependencies(
        definition,
        (key) => this.repository.definition(key),
        true,
      );
      for (const snapshot of [definition, ...Object.values(dependencies)]) {
        const validateScope = async (
          scope: WorkflowDefinition,
        ): Promise<void> => {
          await this.executor.validate?.(scope, origin);
          for (const node of scope.nodes)
            if (node.kind === "loop" && node.config.loop)
              await validateScope({ ...scope, ...node.config.loop.body });
        };
        await validateScope(snapshot);
      }
      for (const snapshot of [definition, ...Object.values(dependencies)])
        await this.checkFiles?.(snapshot);
      await this.checkFiles?.(definition, inputs);
      const values = validateValues(
        definition.nodes.find((n) => n.kind === "input")!.outputs,
        inputs,
      );
      if (
        this.executions.size >= 8 ||
        [...this.runs.values()].filter(
          (r) =>
            r.origin?.agentId === origin?.agentId &&
            ["running", "queued"].includes(r.status),
        ).length >= 2
      )
        throw new DomainError(
          "CONFLICT",
          "工作流并发上限：全局 8 个，同一调用方 2 个",
        );
      if (
        [...this.runs.values()].filter(
          (r) =>
            r.origin?.agentId === origin?.agentId &&
            Date.parse(r.createdAt) > Date.now() - 3600_000,
        ).length >= 60
      )
        throw new DomainError(
          "CONFLICT",
          "同一调用方每小时最多启动 60 次工作流",
        );
      const run: WorkflowRun = {
        id: randomUUID(),
        workflowId,
        definition,
        dependencies,
        status: "queued",
        inputs: values,
        outputs: {},
        nodes: definition.nodes.map((n) => ({
          nodeId: n.id,
          status: "queued",
          events: [],
        })),
        createdAt: new Date().toISOString(),
        origin,
        requestKey,
        requestHash: hash,
      };
      new WorkflowExecutionBudget(run);
      await this.repository.saveRun(run);
      this.runs.set(run.id, run);
      const controller = new AbortController();
      const promise = Promise.resolve()
        .then(() => this.execute(run, controller))
        .catch((error) =>
          this.backgroundError(
            error instanceof Error ? error : new Error("工作流终态持久化失败"),
          ),
        )
        .finally(() => this.executions.delete(run.id));
      this.executions.set(run.id, { controller, promise });
      return structuredClone(run);
    });
  }
  async cancel(
    id: string,
    origin?: WorkflowRun["origin"],
  ): Promise<WorkflowRun> {
    this.getRun(id, origin);
    const job = this.executions.get(id);
    if (job) {
      job.controller.abort(new Error("用户取消工作流"));
      await job.promise;
    }
    return this.getRun(id, origin);
  }
  async wait(
    id: string,
    signal?: AbortSignal,
    progress?: (run: WorkflowRun) => void,
  ): Promise<WorkflowRun> {
    const deadline = Date.now() + 30 * 60_000;
    while (true) {
      const run = this.getRun(id);
      progress?.(run);
      if (
        !["running", "queued"].includes(run.status) ||
        signal?.aborted ||
        Date.now() >= deadline
      )
        return run;
      try {
        await delay(1000, undefined, { signal });
      } catch (error) {
        if (!signal?.aborted) throw error;
        return this.getRun(id);
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    for (const job of this.executions.values())
      job.controller.abort(new Error("服务正在关闭"));
    await Promise.all([...this.executions.values()].map((j) => j.promise));
  }
  private async persist(run: WorkflowRun): Promise<void> {
    await this.repository.saveRun(run);
  }
  /** 所有前驱终态后才调度；普通节点要求全部激活，选择节点允许互斥分支汇合。 */
  private async execute(
    run: WorkflowRun,
    controller: AbortController,
    budget = new WorkflowExecutionBudget(run),
    depth = 0,
  ): Promise<void> {
    if (depth > 16) invalid("工作流执行嵌套超过 16 层");
    const persist = () => this.persist(budget.root);
    const timer =
      depth === 0
        ? setTimeout(
            () => controller.abort(new Error("工作流超过 30 分钟执行上限")),
            30 * 60_000,
          )
        : undefined;
    const signal = controller.signal;
    let primaryFailure: WorkflowNodeRun | undefined;
    const states = new Map(run.nodes.map((n) => [n.nodeId, n]));
    const activeEdges = new Set<string>();
    try {
      run.status = "running";
      await persist();
      while (run.nodes.some((n) => n.status === "queued")) {
        signal.throwIfAborted();
        const ready = run.definition.nodes.filter(
          (n) =>
            states.get(n.id)!.status === "queued" &&
            run.definition.edges
              .filter((e) => e.target === n.id)
              .every((e) =>
                ["succeeded", "skipped"].includes(states.get(e.source)!.status),
              ),
        );
        if (!ready.length)
          throw new DomainError(
            "VALIDATION_FAILED",
            "工作流无可执行节点，分支依赖无法满足",
          );
        const results = await Promise.allSettled(
          ready.slice(0, 3).map(async (node) => {
            const state = states.get(node.id)!;
            const incoming = run.definition.edges.filter(
              (e) => e.target === node.id,
            );
            const enabled =
              node.kind === "input" ||
              (node.kind === "select"
                ? incoming.some((e) => activeEdges.has(e.id))
                : incoming.length > 0 &&
                  incoming.every((e) => activeEdges.has(e.id)));
            if (!enabled) {
              state.status = "skipped";
              state.events.push({
                at: new Date().toISOString(),
                message: "前驱分支未激活，跳过节点",
              });
              await persist();
              return;
            }
            state.status = "running";
            state.startedAt = new Date().toISOString();
            const progress = async (message: string) => {
              signal.throwIfAborted();
              budget.account(message.slice(0, 1000));
              state.progress = message.slice(0, 1000);
              if (state.events.length < 200)
                state.events.push({
                  at: new Date().toISOString(),
                  message: state.progress,
                });
              await persist();
            };
            try {
              budget.step();
              const bindings = Object.entries(node.inputs);
              const inputs = Object.fromEntries(
                bindings.flatMap(([k, b]) => {
                  const value = resolveBinding(b, states);
                  return value === undefined ? [] : [[k, value]];
                }),
              );
              checkValueSize(inputs);
              // 可选参考组未提供时记录为空数组，使运行详情与实际执行输入一致。
              const referenceGroups = Object.fromEntries(
                Object.entries(node.config.referenceGroups ?? {}).map(
                  ([id, group]) => [
                    id,
                    group.binding
                      ? (resolveBinding(group.binding, states) ?? [])
                      : [],
                  ],
                ),
              );
              checkValueSize(referenceGroups);
              budget.account({ inputs, referenceGroups });
              state.referenceGroups = referenceGroups;
              state.inputs = inputs;
              await progress("开始执行节点");
              let output: Record<string, unknown>;
              if (node.kind === "input") output = run.inputs;
              else if (node.kind === "output") output = inputs;
              else if (node.kind === "condition") {
                const values = node.config.conditions!.map((c) =>
                  evaluateCondition(c, states),
                );
                output = {
                  result:
                    node.config.conditionMode === "any"
                      ? values.some(Boolean)
                      : values.every(Boolean),
                };
              } else if (node.kind === "select") {
                const candidates = node.config.candidates!;
                let selected: unknown;
                if (node.config.selectMode === "condition")
                  selected = resolveBinding(
                    candidates[
                      evaluateCondition(node.config.selectCondition!, states)
                        ? 0
                        : 1
                    ],
                    states,
                  );
                else
                  for (const b of candidates) {
                    const v = resolveBinding(b, states);
                    if (v !== undefined) {
                      selected = v;
                      break;
                    }
                  }
                if (selected === undefined)
                  invalid(`选择节点 ${node.name} 没有已执行的候选输入`);
                output = { [node.outputs[0]?.name ?? "result"]: selected };
              } else if (node.kind === "javascript") {
                const result = await budget.leaf(signal, () =>
                  runWorkflowScript(
                    node.config.script!,
                    inputs,
                    node.config.timeoutMs!,
                    signal,
                  ),
                );
                output = result.output;
                for (const message of result.logs)
                  await progress(`脚本：${message}`);
              } else if (node.kind === "loop") {
                output = await this.executeLoop(
                  run,
                  node,
                  inputs,
                  states,
                  signal,
                  budget,
                  depth,
                  progress,
                );
              } else if (node.kind === "workflow") {
                const target =
                  budget.root.dependencies?.[node.config.workflowId!];
                if (!target) invalid(`节点 ${node.name} 缺少目标工作流快照`);
                output = await this.executeChild(
                  run,
                  node,
                  target,
                  inputs,
                  signal,
                  budget,
                  depth,
                  `调用 ${target.name}`,
                );
              } else
                output = await budget.leaf(signal, () =>
                  this.executor.execute(
                    { run, node, signal, progress, referenceGroups },
                    inputs,
                  ),
                );
              signal.throwIfAborted();
              checkValueSize(output);
              // 循环的默认值只用于零轮结果，实际执行时不得掩盖最后一轮缺失的产出。
              const fields =
                node.kind === "loop"
                  ? node.outputs.map((field) => ({
                      ...field,
                      defaultValue: undefined,
                    }))
                  : node.outputs;
              const checked = validateValues(fields, output);
              budget.account(checked);
              state.outputs = checked;
              state.status = "succeeded";
              state.finishedAt = new Date().toISOString();
              if (node.kind === "output") run.outputs = state.outputs;
              for (const edge of run.definition.edges.filter(
                (e) => e.source === node.id,
              )) {
                if (
                  node.kind !== "condition" ||
                  edge.branch === String(output.result)
                )
                  activeEdges.add(edge.id);
              }
              await progress("节点执行完成");
            } catch (error) {
              state.status = signal.aborted ? "cancelled" : "failed";
              state.finishedAt = new Date().toISOString();
              state.error = {
                code:
                  error instanceof DomainError
                    ? error.code
                    : "WORKFLOW_NODE_FAILED",
                message: toSafePublicMessage(
                  error,
                  `节点 ${node.name} 执行器未返回可读异常`,
                ),
                requestId: budget.root.id,
                nodeId: node.id,
              };
              if (!signal.aborted) {
                primaryFailure = state;
                controller.abort(error);
              }
              await persist();
              throw error;
            }
          }),
        );
        const failure = results.find((r) => r.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      if (
        !run.definition.nodes
          .filter((n) => n.kind === "output")
          .every((n) => states.get(n.id)!.status === "succeeded")
      )
        invalid("输出节点未被执行，请通过选择节点汇合互斥分支");
      run.status = "succeeded";
    } catch (error) {
      const failed = primaryFailure ?? run.nodes.find((n) => n.error);
      run.status = primaryFailure
        ? "failed"
        : signal.aborted
          ? "cancelled"
          : "failed";
      run.error = failed?.error ?? {
        code: signal.aborted
          ? "OPERATION_ABORTED"
          : "WORKFLOW_EXECUTION_FAILED",
        message: toSafePublicMessage(error, "工作流调度器未返回可读异常"),
        requestId: budget.root.id,
      };
      for (const n of run.nodes)
        if (["queued", "running"].includes(n.status)) {
          n.status = signal.aborted ? "cancelled" : "skipped";
          n.events.push({
            at: new Date().toISOString(),
            message: "工作流已终止，未继续执行",
          });
        }
    } finally {
      clearTimeout(timer);
      run.finishedAt = new Date().toISOString();
      await persist();
    }
  }
  /** 子调用留在根任务的轨迹树中，不创建独立限流任务或丢失文件归属。 */
  private async executeChild(
    parent: WorkflowRun,
    node: WorkflowNode,
    definition: WorkflowDefinition,
    inputs: Record<string, unknown>,
    signal: AbortSignal,
    budget: WorkflowExecutionBudget,
    depth: number,
    label: string,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    if (depth >= 16) invalid("工作流执行嵌套超过 16 层");
    const child: WorkflowRun = {
      id: randomUUID(),
      workflowId: definition.id,
      definition,
      status: "queued",
      inputs: validateValues(
        definition.nodes.find((n) => n.kind === "input")!.outputs,
        inputs,
      ),
      outputs: {},
      nodes: definition.nodes.map((n) => ({
        nodeId: n.id,
        status: "queued",
        events: [],
      })),
      createdAt: new Date().toISOString(),
      origin: parent.origin,
      requestKey: parent.requestKey,
      requestHash: parent.requestHash,
    };
    budget.account(child);
    const state = parent.nodes.find((item) => item.nodeId === node.id)!;
    (state.children ??= []).push(child);
    state.progress = label;
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    try {
      await this.execute(child, controller, budget, depth + 1);
      if (child.status !== "succeeded")
        throw new DomainError(
          (child.error?.code ?? "REQUEST_FAILED") as ConstructorParameters<
            typeof DomainError
          >[0],
          `${label}：${child.error?.message ?? "子流程未成功完成"}`,
        );
      return child.outputs;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  /** 每轮上下文隔离，成功后才更新状态、提交聚合值，并在下一轮前判断 while。 */
  private async executeLoop(
    run: WorkflowRun,
    node: WorkflowNode,
    inputs: Record<string, unknown>,
    states: Map<string, WorkflowNodeRun>,
    signal: AbortSignal,
    budget: WorkflowExecutionBudget,
    depth: number,
    progress: (message: string) => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const loop = node.config.loop!;
    const bodyInput = loop.body.nodes.find((n) => n.kind === "input")!;
    const variables = Object.fromEntries(
      Object.entries(loop.state).map(([name, value]) => [
        name,
        resolveBinding(value.initial, states),
      ]),
    );
    const items =
      loop.mode === "array" ? resolveBinding(loop.items, states) : [];
    const count =
      loop.mode === "count" ? resolveBinding(loop.count, states) : undefined;
    if (
      loop.mode === "count" &&
      (!Number.isInteger(count) ||
        Number(count) < 0 ||
        Number(count) > loop.maxIterations)
    )
      invalid(`循环 ${node.name} 次数必须为 0 到 ${loop.maxIterations} 的整数`);
    if (
      loop.mode === "array" &&
      (!Array.isArray(items) || items.length > loop.maxIterations)
    )
      invalid(
        `循环 ${node.name} 的迭代输入必须为最多 ${loop.maxIterations} 项的数组`,
      );
    const output: Record<string, unknown> = {};
    for (const [name, mapping] of Object.entries(loop.outputs))
      if (mapping.mode !== "last") output[name] = [];
    let index = 0;
    while (true) {
      signal.throwIfAborted();
      const rawContext = {
        ...inputs,
        ...variables,
        index,
        ...(loop.mode === "array" ? { item: (items as unknown[])[index] } : {}),
      };
      if (loop.mode === "count" && index >= Number(count)) break;
      if (loop.mode === "array" && index >= (items as unknown[]).length) break;
      const context = validateValues(bodyInput.outputs, rawContext);
      if (
        loop.mode === "while" &&
        !evaluateCondition(
          loop.condition,
          new Map([
            [
              bodyInput.id,
              {
                nodeId: bodyInput.id,
                status: "succeeded",
                outputs: context,
                events: [],
              },
            ],
          ]),
        )
      )
        break;
      if (index >= loop.maxIterations)
        invalid(
          `循环 ${node.name} 达到 ${loop.maxIterations} 次上限，while 条件仍为真`,
        );
      await progress(
        `第 ${index + 1} 轮 · ${loop.mode === "while" ? `最多 ${loop.maxIterations} 轮` : `共 ${loop.mode === "array" ? (items as unknown[]).length : count} 轮`}`,
      );
      const definition: WorkflowDefinition = {
        ...loop.body,
        id: `${run.workflowId}/${node.id}`,
        revision: run.definition.revision,
        createdAt: run.createdAt,
        updatedAt: run.createdAt,
      };
      const values = await this.executeChild(
        run,
        node,
        definition,
        context,
        signal,
        budget,
        depth,
        `循环 ${node.name} 第 ${index + 1} 轮`,
      );
      for (const [name, variable] of Object.entries(loop.state)) {
        const value = values[variable.output];
        const field = bodyInput.outputs.find((f) => f.name === name)!;
        validateValues([{ ...field, required: true }], { [name]: value });
        variables[name] = value;
      }
      for (const [name, mapping] of Object.entries(loop.outputs)) {
        const value = values[mapping.field];
        if (mapping.mode === "last") {
          if (value === undefined) delete output[name];
          else output[name] = value;
        } else {
          if (value === undefined || value === null)
            invalid(
              `循环 ${node.name} 第 ${index + 1} 轮未提供聚合输出 ${mapping.field}`,
            );
          const list = output[name] as unknown[];
          if (mapping.mode === "flatten") {
            if (!Array.isArray(value))
              invalid(
                `循环 ${node.name} 的合并输出 ${mapping.field} 必须为数组`,
              );
            list.push(...value);
          } else list.push(value);
          if (list.length > 100)
            invalid(`循环 ${node.name} 聚合输出 ${name} 超过 100 项`);
        }
      }
      checkValueSize(output);
      index++;
    }
    if (index === 0) {
      for (const [name, mapping] of Object.entries(loop.outputs)) {
        if (mapping.mode !== "last") continue;
        const variable = Object.entries(loop.state).find(
          ([, state]) => state.output === mapping.field,
        );
        if (variable) output[name] = variables[variable[0]];
        else {
          const fallback = node.outputs.find(
            (field) => field.name === name,
          )?.defaultValue;
          if (fallback !== undefined) output[name] = fallback;
        }
      }
    }
    await progress(`循环完成 · 已执行 ${index} 轮`);
    return output;
  }
}
/** 安全读取上游命名输出；分支未执行时返回 undefined，保留 null/false/0。 */
export function resolveBinding(
  binding: WorkflowBinding,
  states: Map<string, WorkflowNodeRun>,
): unknown {
  if (binding.kind === "literal") return binding.value;
  const state = states.get(binding.nodeId);
  return state?.status === "succeeded"
    ? state.outputs?.[binding.field]
    : undefined;
}
export function evaluateCondition(
  condition: WorkflowCondition,
  states: Map<string, WorkflowNodeRun>,
): boolean {
  const a = resolveBinding(condition.left, states),
    b = resolveBinding(condition.right, states);
  const empty =
    a === undefined ||
    a === null ||
    a === "" ||
    (Array.isArray(a) && a.length === 0);
  switch (condition.operator) {
    case "empty":
      return empty;
    case "not_empty":
      return !empty;
    case "eq":
      return stableJson(a) === stableJson(b);
    case "ne":
      return stableJson(a) !== stableJson(b);
    case "contains":
      return typeof a === "string" && typeof b === "string"
        ? a.includes(b)
        : Array.isArray(a) && a.some((v) => stableJson(v) === stableJson(b));
    default:
      if (typeof a !== "number" || typeof b !== "number")
        invalid("数值比较条件两侧必须都是数值");
      return condition.operator === "gt"
        ? a > b
        : condition.operator === "gte"
          ? a >= b
          : condition.operator === "lt"
            ? a < b
            : a <= b;
  }
}
/** 对象键排序用于幂等与结构化相等判断，不改变数组顺序。 */
function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, v) =>
    record(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}
