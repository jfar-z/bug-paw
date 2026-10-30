import { workflowClientId } from "./workflow-id";
import { useWorkflowConfirm } from "./workflow-confirm";
import { memo, useLayoutEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  type NodeProps,
  type Node,
  type Connection,
  type ReactFlowInstance,
  type OnConnectEnd,
  type XYPosition,
} from "@xyflow/react";
import {
  Plus,
  Workflow,
  Code,
  GitBranch,
  Bot,
  Sparkles,
  ArrowRightLeft,
  LogIn,
  LogOut,
} from "lucide-react";
import {
  WORKFLOW_NODE_NAMES,
  newWorkflowNode,
  type WorkflowDraft,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowCatalog,
  type WorkflowBinding,
} from "../../../shared/workflow-contracts";
import { WorkflowNodeEditor } from "./workflow-node-editor";
import { useApiTask } from "../../api-task-provider";
import "@xyflow/react/dist/style.css";

const icons = {
  input: LogIn,
  output: LogOut,
  llm: Sparkles,
  agent: Bot,
  aigc: Workflow,
  condition: GitBranch,
  select: ArrowRightLeft,
  javascript: Code,
};
export type CanvasNode = Node<{ node: WorkflowNode }, "workflow">;
type PendingConnection = {
  nodeId: string;
  type: "source" | "target";
  handleId?: string | null;
  position: XYPosition;
};
/** 保留测量尺寸、选择与拖动状态，避免更新业务定义时让所有节点重新测量。 */
export function syncCanvasNodes(
  previous: CanvasNode[],
  nodes: WorkflowNode[],
): CanvasNode[] {
  const lookup = new Map(previous.map((node) => [node.id, node]));
  return nodes.map((node) => {
    const old = lookup.get(node.id);
    if (old?.data.node === node) return old;
    return {
      ...old,
      id: node.id,
      type: "workflow",
      position: node.position,
      data: { node },
      deletable: !["input", "output"].includes(node.kind),
    };
  });
}
/** 松手坐标与菜单显示位置分开保存，菜单避让边缘不会改变节点落点。 */
export function appendWorkflowNode(
  draft: WorkflowDraft,
  kind: WorkflowNodeKind,
  position: XYPosition,
  pending?: PendingConnection,
): WorkflowDraft {
  const item = newWorkflowNode(
    kind,
    `node_${workflowClientId().replaceAll("-", "")}`,
    position,
  );
  const origin =
    pending && draft.nodes.find((node) => node.id === pending.nodeId);
  const branch =
    pending?.type === "source"
      ? pending.handleId === "true" || pending.handleId === "false"
        ? pending.handleId
        : undefined
      : kind === "condition"
        ? "true"
        : undefined;
  return {
    ...draft,
    nodes: [...draft.nodes, item],
    edges: origin
      ? [
          ...draft.edges,
          {
            id: workflowClientId(),
            source: pending.type === "source" ? origin.id : item.id,
            target: pending.type === "source" ? item.id : origin.id,
            branch,
          },
        ]
      : draft.edges,
  };
}
/** 节点只显示类型和参数摘要，完整配置由右侧面板承担。 */
const NodeCard = memo(function NodeCard({
  data,
  selected,
}: NodeProps<CanvasNode>) {
  const node = data.node,
    Icon = icons[node.kind];
  return (
    <div className={`wf-node${selected ? " is-selected" : ""}`}>
      {node.kind !== "input" && (
        <Handle type="target" position={Position.Left} aria-label="输入连接" />
      )}
      <div className="wf-node-heading">
        <span className="wf-node-icon">
          <Icon size={18} />
        </span>
        <div>
          <small>{WORKFLOW_NODE_NAMES[node.kind]}</small>
          <strong>{node.name}</strong>
        </div>
      </div>
      <div className="wf-node-ports">
        {node.outputs.length ? (
          node.outputs.slice(0, 3).map((f) => (
            <div key={f.name}>
              <code>{f.name}</code>
              <span>
                {f.type}
                {f.multiple ? "[]" : ""}
              </span>
            </div>
          ))
        ) : (
          <span>配置输出参数</span>
        )}
      </div>
      {node.kind === "condition" ? (
        <>
          <span className="wf-branch wf-branch-true">IF</span>
          <Handle
            id="true"
            type="source"
            position={Position.Right}
            style={{ top: "42%" }}
            aria-label="条件满足"
          />
          <span className="wf-branch wf-branch-false">ELSE</span>
          <Handle
            id="false"
            type="source"
            position={Position.Right}
            style={{ top: "80%" }}
            aria-label="条件不满足"
          />
        </>
      ) : (
        node.kind !== "output" && (
          <Handle
            type="source"
            position={Position.Right}
            aria-label="输出连接"
          />
        )
      )}
    </div>
  );
});
const nodeTypes = { workflow: NodeCard };
/** 检查控制依赖路径，数据引用新增依赖时也复用这一判断。 */
export function workflowHasPath(
  draft: WorkflowDraft,
  source: string,
  target: string,
  seen = new Set<string>(),
): boolean {
  if (source === target) return true;
  if (seen.has(source)) return false;
  seen.add(source);
  return draft.edges.some(
    (e) =>
      e.source === source && workflowHasPath(draft, e.target, target, seen),
  );
}
/** 收集配置中的引用；绑定与控制边保持一致，已有分支路径不被直连旁路覆盖。 */
export function withWorkflowNode(
  draft: WorkflowDraft,
  node: WorkflowNode,
): WorkflowDraft {
  let next = {
    ...draft,
    nodes: draft.nodes.map((n) => (n.id === node.id ? node : n)),
    edges: [...draft.edges],
  };
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const b = value as WorkflowBinding;
    if (b.kind === "reference") {
      if (workflowHasPath(next, node.id, b.nodeId))
        throw new Error("该引用会形成循环，请选择上游节点。");
      if (!workflowHasPath(next, b.nodeId, node.id)) {
        const source = next.nodes.find((n) => n.id === b.nodeId);
        if (source?.kind === "condition")
          throw new Error(
            "请先从判断节点的 IF 或 ELSE 端口连接目标节点，再引用结果。",
          );
        next.edges.push({
          id: workflowClientId(),
          source: b.nodeId,
          target: node.id,
        });
      }
    } else for (const child of Object.values(value)) visit(child);
  };
  visit(node.inputs);
  visit(node.config.conditions);
  visit(node.config.candidates);
  visit(node.config.selectCondition);
  return next;
}
/** 可拖动、连线和键盘操作的 DAG 编辑画布。 */
export function WorkflowCanvas({
  draft,
  catalog,
  onChange,
  onValidity,
}: {
  draft: WorkflowDraft;
  catalog: WorkflowCatalog;
  onChange: (draft: WorkflowDraft) => void;
  onValidity: (key: string, valid: boolean) => void;
}) {
  const confirm = useWorkflowConfirm();
  const [selected, setSelected] = useState<string>();
  const [palette, setPalette] = useState<{
    left: number;
    top: number;
    pending?: PendingConnection;
  }>();
  const { runApiTask } = useApiTask();
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const [nodes, setNodes] = useState(() => syncCanvasNodes([], draft.nodes));
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const deleting = useRef(false);
  const latest = useRef({ draft, onChange });
  latest.current = { draft, onChange };
  useLayoutEffect(() => {
    setNodes((old) => syncCanvasNodes(old, draft.nodes));
  }, [draft.nodes]);
  useLayoutEffect(() => {
    if (!palette) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as HTMLElement))
        setPalette(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [palette]);
  const node = draft.nodes.find((n) => n.id === selected);
  const changeNode = (next: WorkflowNode) =>
    void runApiTask(async () => onChange(withWorkflowNode(draft, next)), {
      operation: "更新节点依赖",
    });
  const remove = (ids: string[], edgeIds: string[] = []) =>
    flow.current?.deleteElements({
      nodes: ids.map((id) => ({ id })),
      edges: edgeIds.map((id) => ({ id })),
    });
  const finishConnection: OnConnectEnd = (event, state) => {
    // 只有拖到画布空白处才创建节点；错误端口或已有节点仍沿用普通连线校验。
    if (state.isValid || !state.fromNode) return;
    const pointer = "changedTouches" in event ? event.changedTouches[0] : event;
    const bounds = canvas.current?.getBoundingClientRect();
    if (!pointer || !bounds || !flow.current) return;
    // TouchEvent.target 保留起始端口，松手目标必须按最终屏幕坐标重新定位。
    const target = document.elementFromPoint(pointer.clientX, pointer.clientY);
    if (
      !target?.closest(".react-flow__pane") ||
      !canvas.current?.contains(target)
    )
      return;
    setPalette({
      left: Math.max(
        8,
        Math.min(pointer.clientX - bounds.left, bounds.width - 206),
      ),
      top: Math.max(
        8,
        Math.min(pointer.clientY - bounds.top, bounds.height - 300),
      ),
      pending: {
        nodeId: state.fromNode.id,
        type: state.fromHandle.type,
        handleId: state.fromHandle.id,
        position: flow.current.screenToFlowPosition({
          x: pointer.clientX,
          y: pointer.clientY,
        }),
      },
    });
  };
  const connect = (connection: Connection) =>
    void runApiTask(
      async () => {
        const { source, target, sourceHandle } = connection;
        if (workflowHasPath(draft, target, source))
          throw new Error("DAG 不能包含循环连线。");
        if (
          draft.nodes.find((n) => n.id === target)?.kind === "input" ||
          draft.nodes.find((n) => n.id === source)?.kind === "output"
        )
          throw new Error("输入节点只可作为起点，输出节点只可作为终点。");
        const branch =
          sourceHandle === "true" || sourceHandle === "false"
            ? sourceHandle
            : undefined;
        if (
          draft.edges.some(
            (e) =>
              e.source === source && e.target === target && e.branch === branch,
          )
        )
          return;
        onChange({
          ...draft,
          edges: [
            ...draft.edges,
            { id: workflowClientId(), source, target, branch },
          ],
        });
      },
      { operation: "连接工作流节点" },
    );
  return (
    <div
      className="wf-editor-body"
      onKeyDown={(event) => {
        if (event.key === "Escape" && palette) {
          event.preventDefault();
          setPalette(undefined);
          canvas.current?.focus();
          return;
        }
        if (
          event.repeat ||
          palette ||
          !["Delete", "Backspace"].includes(event.key)
        )
          return;
        if (
          event.target instanceof Element &&
          event.target.closest(
            "input, textarea, select, button, [contenteditable]:not([contenteditable='false'])",
          )
        )
          return;
        const ids = nodes
          .filter((node) => node.selected && node.deletable)
          .map((node) => node.id);
        if (!ids.length && !selectedEdges.length) return;
        event.preventDefault();
        void remove(ids, selectedEdges);
      }}
    >
      <div className="wf-canvas" ref={canvas} tabIndex={-1}>
        <div className="wf-canvas-toolbar">
          <button
            className="wf-button"
            aria-expanded={!!palette}
            onClick={() =>
              setPalette(palette ? undefined : { left: 16, top: 62 })
            }
          >
            <Plus size={16} />
            添加节点
          </button>
          <span>拖线到空白处添加节点 · 选中节点或连线后按 Delete 删除</span>
          {selectedEdges.length > 0 && (
            <button
              className="wf-button"
              onClick={() => void remove([], selectedEdges)}
            >
              删除连线
            </button>
          )}
        </div>
        {palette && (
          <div
            className="wf-palette"
            ref={menu}
            role="menu"
            aria-label="可用节点"
            style={{ left: palette.left, top: palette.top }}
            onKeyDown={(event) => {
              const buttons = [
                ...(menu.current?.querySelectorAll<HTMLButtonElement>(
                  "button",
                ) ?? []),
              ];
              const index = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            {(Object.keys(WORKFLOW_NODE_NAMES) as WorkflowNodeKind[])
              .filter((k) => !["input", "output"].includes(k))
              .map((kind) => {
                const Icon = icons[kind];
                return (
                  <button
                    key={kind}
                    role="menuitem"
                    onClick={() => {
                      const bounds = canvas.current?.getBoundingClientRect();
                      const position =
                        palette.pending?.position ??
                        (bounds && flow.current
                          ? flow.current.screenToFlowPosition({
                              x: bounds.left + bounds.width / 2,
                              y: bounds.top + bounds.height / 2,
                            })
                          : { x: 80, y: 140 });
                      const next = appendWorkflowNode(
                        draft,
                        kind,
                        position,
                        palette.pending,
                      );
                      const item = next.nodes.at(-1)!;
                      onChange(next);
                      setNodes((old) =>
                        syncCanvasNodes(old, next.nodes).map((node) => ({
                          ...node,
                          selected: node.id === item.id,
                        })),
                      );
                      setSelectedEdges([]);
                      // 保持侧栏开闭状态，避免画布宽度变化挪动松手落点。
                      setSelected(
                        palette.pending && !selected ? undefined : item.id,
                      );
                      setPalette(undefined);
                      canvas.current?.focus();
                    }}
                  >
                    <Icon size={18} />
                    {WORKFLOW_NODE_NAMES[kind]}
                    {palette.pending?.type === "target" && kind === "condition"
                      ? " · IF"
                      : ""}
                  </button>
                );
              })}
          </div>
        )}
        <ReactFlow<CanvasNode>
          onInit={(instance) => {
            flow.current = instance;
          }}
          nodes={nodes}
          edges={draft.edges.map((e) => ({
            ...e,
            sourceHandle: e.branch,
            selected: selectedEdges.includes(e.id),
            label:
              e.branch === "true"
                ? "IF"
                : e.branch === "false"
                  ? "ELSE"
                  : undefined,
          }))}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => {
            setSelected(n.id);
            setSelectedEdges([]);
          }}
          onPaneClick={() => {
            setSelected(undefined);
            setPalette(undefined);
            canvas.current?.focus();
          }}
          onNodesChange={(changes) => {
            setNodes((old) => applyNodeChanges(changes, old));
            const positions = new Map<string, XYPosition>();
            for (const change of changes) {
              if (change.type === "position" && change.position)
                positions.set(change.id, change.position);
            }
            if (!positions.size) return;
            const current = latest.current;
            current.onChange({
              ...current.draft,
              nodes: current.draft.nodes.map((node) =>
                positions.has(node.id)
                  ? { ...node, position: positions.get(node.id)! }
                  : node,
              ),
            });
          }}
          onEdgesChange={(changes) =>
            setSelectedEdges((old) => {
              let next = [...old];
              for (const change of changes)
                if (change.type === "select") {
                  next = next.filter((id) => id !== change.id);
                  if (change.selected) next.push(change.id);
                }
              return next;
            })
          }
          onBeforeDelete={async ({ nodes }) => {
            if (deleting.current) return false;
            if (!nodes.length) return true;
            deleting.current = true;
            try {
              return await confirm(
                `删除 ${nodes.length} 个节点及关联连线？引用这些节点的参数需要重新配置。`,
              );
            } finally {
              deleting.current = false;
            }
          }}
          onDelete={({ nodes: removed, edges }) => {
            const current = latest.current;
            const ids = new Set(removed.map((node) => node.id));
            const edgeIds = new Set(edges.map((edge) => edge.id));
            current.onChange({
              ...current.draft,
              nodes: current.draft.nodes.filter((node) => !ids.has(node.id)),
              edges: current.draft.edges.filter(
                (edge) =>
                  !edgeIds.has(edge.id) &&
                  !ids.has(edge.source) &&
                  !ids.has(edge.target),
              ),
            });
            if (selected && ids.has(selected)) setSelected(undefined);
            setSelectedEdges((old) => old.filter((id) => !edgeIds.has(id)));
          }}
          onConnectStart={() => {
            setPalette(undefined);
          }}
          onConnectEnd={finishConnection}
          onConnect={connect}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          deleteKeyCode={null}
          aria-label="工作流 DAG 画布"
        >
          <Background color="var(--border-strong)" gap={22} />
          <Controls showInteractive={false} />
        </ReactFlow>
        <div className="wf-canvas-caption">
          {draft.nodes.length} 个节点 · {draft.edges.length} 条连线
        </div>
      </div>
      {node && (
        <WorkflowNodeEditor
          key={node.id}
          node={node}
          nodes={draft.nodes}
          catalog={catalog}
          onChange={changeNode}
          onClose={() => setSelected(undefined)}
          onDelete={() => void remove([node.id])}
          onCopy={() => {
            const copy = structuredClone(node);
            copy.id = `node_${workflowClientId().replaceAll("-", "")}`;
            copy.name += " 副本";
            copy.position = {
              x: node.position.x + 40,
              y: node.position.y + 170,
            };
            const next = { ...draft, nodes: [...draft.nodes, copy] };
            onChange(withWorkflowNode(next, copy));
            setSelected(copy.id);
          }}
          onValidity={onValidity}
        />
      )}
    </div>
  );
}
