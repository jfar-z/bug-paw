import { workflowClientId } from "./workflow-id";
import { useWorkflowConfirm } from "./workflow-confirm";
import { useEffect, useRef, useState } from "react";
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
type CanvasNode = Node<{ node: WorkflowNode }, "workflow">;
/** 节点只显示类型和参数摘要，完整配置由右侧面板承担。 */
function NodeCard({ data, selected }: NodeProps<CanvasNode>) {
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
}
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
  const [selected, setSelected] = useState<string>(),
    [palette, setPalette] = useState(false);
  const { runApiTask } = useApiTask();
  const [selectedEdges, setSelectedEdges] = useState<string[]>([]);
  const flow = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      void flow.current?.fitView({ padding: 0.2, duration: 0 });
    }, 80);
    return () => clearTimeout(timer);
  }, [draft.nodes.length]);
  const node = draft.nodes.find((n) => n.id === selected);
  const changeNode = (next: WorkflowNode) =>
    void runApiTask(async () => onChange(withWorkflowNode(draft, next)), {
      operation: "更新节点依赖",
    });
  const remove = async (id: string) => {
    if (!(await confirm("删除节点及连线？引用该节点的参数需要重新配置。")))
      return;
    onChange({
      ...draft,
      nodes: draft.nodes.filter((n) => n.id !== id),
      edges: draft.edges.filter((e) => e.source !== id && e.target !== id),
    });
    setSelected(undefined);
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
    <div className="wf-editor-body">
      <div className="wf-canvas">
        <div className="wf-canvas-toolbar">
          <button
            className="wf-button"
            aria-expanded={palette}
            onClick={() => setPalette(!palette)}
          >
            <Plus size={16} />
            添加节点
          </button>
          <span>拖动端口连线 · 选择连线后按 Delete 删除</span>
          {selectedEdges.length > 0 && (
            <button
              className="wf-button"
              onClick={() => {
                onChange({
                  ...draft,
                  edges: draft.edges.filter(
                    (e) => !selectedEdges.includes(e.id),
                  ),
                });
                setSelectedEdges([]);
              }}
            >
              删除连线
            </button>
          )}
        </div>
        {palette && (
          <div className="wf-palette" aria-label="可用节点">
            {(Object.keys(WORKFLOW_NODE_NAMES) as WorkflowNodeKind[])
              .filter((k) => !["input", "output"].includes(k))
              .map((kind) => {
                const Icon = icons[kind];
                return (
                  <button
                    key={kind}
                    onClick={() => {
                      const item = newWorkflowNode(
                        kind,
                        `node_${workflowClientId().replaceAll("-", "")}`,
                        {
                          x: 80 + ((draft.nodes.length - 2) % 3) * 280,
                          y:
                            140 +
                            (Math.floor((draft.nodes.length - 2) / 3) + 1) *
                              180,
                        },
                      );
                      onChange({ ...draft, nodes: [...draft.nodes, item] });
                      setSelected(item.id);
                      setPalette(false);
                    }}
                  >
                    <Icon size={18} />
                    {WORKFLOW_NODE_NAMES[kind]}
                  </button>
                );
              })}
          </div>
        )}
        <ReactFlow<CanvasNode>
          onInit={(instance) => {
            flow.current = instance;
          }}
          nodes={draft.nodes.map((n) => ({
            id: n.id,
            type: "workflow",
            position: n.position,
            data: { node: n },
            selected: n.id === selected,
            deletable: false,
          }))}
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
          onNodeClick={(_, n) => setSelected(n.id)}
          onPaneClick={() => setSelected(undefined)}
          onNodesChange={(changes) => {
            const moved = applyNodeChanges(
              changes,
              draft.nodes.map((n) => ({
                id: n.id,
                type: "workflow",
                position: n.position,
                data: { node: n },
              })),
            );
            if (changes.some((c) => c.type === "position"))
              onChange({
                ...draft,
                nodes: draft.nodes.map((n) => ({
                  ...n,
                  position:
                    moved.find((m) => m.id === n.id)?.position ?? n.position,
                })),
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
          onEdgesDelete={(edges) =>
            onChange({
              ...draft,
              edges: draft.edges.filter(
                (e) => !edges.some((d) => d.id === e.id),
              ),
            })
          }
          onConnect={connect}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          deleteKeyCode={["Backspace", "Delete"]}
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
          onDelete={() => void remove(node.id)}
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
